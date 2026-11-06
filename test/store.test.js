import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore, remapPath } from '../server/projects/store.js';

let dir;
let store;
const entry = (p, content = '') => ({ path: p, data: Buffer.from(content) });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localleaf-store-'));
  store = new ProjectStore(dir);
  await store.init();
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('ProjectStore', () => {
  it('creates a blank project with a main.tex', async () => {
    const meta = await store.create({ name: '  My   paper ' });
    expect(meta).toMatchObject({ name: 'My paper', mainFile: 'main.tex', engine: 'pdflatex' });
    const file = await store.readFile(meta.id, 'main.tex');
    expect(file.editable).toBe(true);
    expect(file.content).toContain('\\documentclass');
    expect(await store.list()).toHaveLength(1);
  });

  it('imports entries and lists the tree', async () => {
    const meta = await store.create({ name: 'p', entries: [entry('main.tex', '\\documentclass{x}'), entry('figs/a.png', '\x89PNG\0')] });
    const tree = await store.tree(meta.id);
    expect(tree.map((e) => `${e.type}:${e.path}`)).toEqual(['dir:figs', 'file:figs/a.png', 'file:main.tex']);
    expect((await store.readFile(meta.id, 'figs/a.png')).editable).toBe(false);
  });

  it('writes, moves and deletes files, keeping mainFile consistent', async () => {
    const { id } = await store.create({ name: 'p' });
    await store.writeFile(id, 'sec/intro.tex', Buffer.from('hi'));
    await store.move(id, 'main.tex', 'src/main.tex');
    expect((await store.get(id)).mainFile).toBe('src/main.tex');
    await store.move(id, 'src', 'source');
    expect((await store.get(id)).mainFile).toBe('source/main.tex');
    await store.deleteEntry(id, 'source');
    expect((await store.get(id)).mainFile).toBeNull();
    expect((await store.tree(id)).map((e) => e.path)).toEqual(['sec', 'sec/intro.tex']);
  });

  it('validates updates', async () => {
    const { id } = await store.create({ name: 'p' });
    await expect(store.update(id, { engine: 'bogus' })).rejects.toThrow(/Engine/);
    await expect(store.update(id, { mainFile: 'missing.tex' })).rejects.toThrow(/does not exist/);
    await expect(store.update(id, { mainFile: 'main.png' })).rejects.toThrow(/\.tex/);
    await expect(store.update(id, { name: '' })).rejects.toThrow(/empty/);
    const next = await store.update(id, { engine: 'xelatex', name: 'Renamed' });
    expect(next).toMatchObject({ engine: 'xelatex', name: 'Renamed' });
  });

  it('rejects conflicts, traversal and unknown ids', async () => {
    const { id } = await store.create({ name: 'p' });
    await store.createFolder(id, 'figs');
    await expect(store.createFolder(id, 'figs')).rejects.toThrow(/exists/);
    await expect(store.writeFile(id, 'figs', Buffer.from(''))).rejects.toThrow(/folder/);
    await expect(store.move(id, 'figs', 'figs/inner')).rejects.toThrow(/into itself/);
    await expect(store.move(id, 'nope', 'x')).rejects.toThrow(/does not exist/);
    await expect(store.writeFile(id, '../escape.tex', Buffer.from(''))).rejects.toThrow(/outside/);
    await expect(store.get('../../etc')).rejects.toThrow(/not found/);
    await expect(store.get('0123456789abcdef')).rejects.toThrow(/not found/);
    await expect(store.readFile(id, 'missing.tex')).rejects.toThrow(/not found/);
  });

  it('exports entries, clears output and removes projects', async () => {
    const { id } = await store.create({ name: 'p' });
    await fs.writeFile(path.join(store.outputDir(id), 'main.aux'), 'x');
    await store.clearOutput(id);
    expect(await fs.readdir(store.outputDir(id))).toEqual([]);
    expect((await store.exportEntries(id)).map((e) => e.path)).toEqual(['main.tex']);
    await store.remove(id);
    expect(await store.list()).toEqual([]);
  });
});

describe('remapPath', () => {
  it('handles exact, nested and unrelated paths', () => {
    expect(remapPath('a.tex', 'a.tex', 'b.tex')).toBe('b.tex');
    expect(remapPath('src/a.tex', 'src', 'lib')).toBe('lib/a.tex');
    expect(remapPath('srcx/a.tex', 'src', 'lib')).toBe('srcx/a.tex');
    expect(remapPath(null, 'a', 'b')).toBeNull();
  });
});
