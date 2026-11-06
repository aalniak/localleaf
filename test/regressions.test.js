// Regression tests for issues found in code review.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/projects/store.js';
import { CompileService } from '../server/compiler/service.js';
import { parseLatexLog } from '../server/compiler/logParser.js';
import { normalizeRelPath, isSafeMainFile } from '../server/paths.js';

let dir;
let store;
const entry = (p, content = '') => ({ path: p, data: Buffer.from(content) });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localleaf-reg-'));
  store = new ProjectStore(dir);
  await store.init();
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('main document names cannot inject options or TeX', () => {
  it.each(['-pdflatex=evil #.tex', 'a{b}.tex', 'x\\input.tex', 'p%.tex', 'a&b.tex'])('rejects %j', (name) => {
    expect(isSafeMainFile(name)).toBe(false);
  });
  it('accepts ordinary names, including spaces', () => {
    expect(isSafeMainFile('FO-TEX Template.tex')).toBe(true);
    expect(isSafeMainFile('chapters/main-v2.tex')).toBe(true);
  });
  it('is enforced by update(), import detection and compile()', async () => {
    const { id } = await store.create({ name: 'p', entries: [entry('-x.tex', '\\documentclass{article}')] });
    expect((await store.get(id)).mainFile).toBeNull();
    await expect(store.update(id, { mainFile: '-x.tex' })).rejects.toThrow(/cannot start with/);
    const backend = { name: 'x', compile: async () => { throw new Error('must not run'); } };
    await fs.writeFile(path.join(store.projectDir(id), 'project.json'), JSON.stringify({ ...(await store.get(id)), mainFile: '-x.tex' }));
    await expect(new CompileService({ store, backend }).compile(id)).rejects.toThrow(/cannot compile/);
  });
});

describe('Windows filesystem semantics', () => {
  it.each(['NUL.tex', 'con', 'figs/COM1.png', 'trailing.', 'space '])('rejects reserved name %j', (name) => {
    expect(() => normalizeRelPath(name)).toThrow();
  });
  it('rejects archives with case-insensitive or file/folder collisions, leaving no orphan', async () => {
    await expect(store.create({ name: 'p', entries: [entry('A.tex'), entry('a.tex')] })).rejects.toThrow(/overwrite/);
    await expect(store.create({ name: 'p', entries: [entry('a'), entry('a/b.tex')] })).rejects.toThrow(/file and a folder/);
    expect(await fs.readdir(store.root)).toEqual([]);
  });
  it('allows case-only renames and keeps mainFile in sync', async () => {
    const { id } = await store.create({ name: 'p' });
    await store.move(id, 'main.tex', 'Main.tex');
    expect((await store.get(id)).mainFile).toBe('Main.tex');
    expect((await store.tree(id)).map((e) => e.path)).toEqual(['Main.tex']);
  });
});

describe('concurrent metadata writes', () => {
  it('does not lose an update when autosaves touch() concurrently', async () => {
    const { id } = await store.create({ name: 'p' });
    await store.writeFile(id, 'other.tex', Buffer.from('x'));
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.writeFile(id, `f${i}.tex`, Buffer.from('y'))),
      store.update(id, { engine: 'lualatex', mainFile: 'other.tex' }),
      ...Array.from({ length: 10 }, () => store.touch(id)),
    ]);
    expect(await store.get(id)).toMatchObject({ engine: 'lualatex', mainFile: 'other.tex' });
    const leftovers = (await fs.readdir(store.projectDir(id))).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('log parser robustness', () => {
  it('ignores parentheses in echoed error context when tracking files', () => {
    const log = [
      '(./main.tex (./chap.tex',
      '! Undefined control sequence.',
      'l.3 smile :-) \\oops',
      '',
      'LaTeX Warning: Reference `x\' on page 1 undefined on input line 9.',
      ')',
      ')',
    ].join('\n');
    const parsed = parseLatexLog(log);
    expect(parsed.errors[0]).toMatchObject({ file: 'chap.tex', line: 3 });
    expect(parsed.warnings[0]).toMatchObject({ file: 'chap.tex', line: 9 });
  });
});

describe('compile status', () => {
  it('reports a toolchain crash without a log as failure, not "none"', async () => {
    const { id } = await store.create({ name: 'p' });
    const backend = { name: 'x', compile: async () => ({ code: 125, stdout: '', stderr: 'docker: error', timedOut: false, rootPrefix: '' }) };
    const res = await new CompileService({ store, backend }).compile(id);
    expect(res).toMatchObject({ status: 'failure', output: 'docker: error' });
  });

  it('removes stale SyncTeX/BibTeX outputs before compiling', async () => {
    const { id } = await store.create({ name: 'p' });
    const stale = path.join(store.outputDir(id), 'main.synctex.gz');
    await fs.writeFile(stale, 'old');
    const backend = { name: 'x', compile: async () => ({ code: 0, stdout: '', stderr: '', rootPrefix: '' }) };
    await new CompileService({ store, backend }).compile(id);
    await expect(fs.stat(stale)).rejects.toThrow();
  });
});
