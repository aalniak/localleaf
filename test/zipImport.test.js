import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { readZipEntries, stripCommonRoot, detectMainFile, buildZip } from '../server/projects/zipImport.js';

const zipOf = (files) => {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
};
const entry = (path, content = '') => ({ path, data: Buffer.from(content) });

describe('readZipEntries', () => {
  it('reads files and skips macOS junk', () => {
    const entries = readZipEntries(zipOf({ 'main.tex': 'x', '__MACOSX/._main.tex': 'junk', 'figs/.DS_Store': 'junk', 'figs/a.png': 'png' }));
    expect(entries.map((e) => e.path).sort()).toEqual(['figs/a.png', 'main.tex']);
  });

  it('strips a single wrapping folder', () => {
    const entries = readZipEntries(zipOf({ 'paper/main.tex': 'x', 'paper/figs/a.png': 'y' }));
    expect(entries.map((e) => e.path).sort()).toEqual(['figs/a.png', 'main.tex']);
  });

  it('rejects invalid archives and empty archives', () => {
    expect(() => readZipEntries(Buffer.from('not a zip'))).toThrow(/valid zip/);
    expect(() => readZipEntries(zipOf({ '__MACOSX/x': 'y' }))).toThrow(/no files/);
  });

  it('rejects zip-slip entry names', () => {
    const zip = new AdmZip();
    zip.addFile('ok.tex', Buffer.from('x'));
    zip.getEntries()[0].entryName = '../../evil.tex';
    expect(() => readZipEntries(zip.toBuffer())).toThrow(/outside/);
  });
});

describe('stripCommonRoot', () => {
  it('leaves mixed roots alone', () => {
    const entries = [entry('a/x.tex'), entry('b/y.tex')];
    expect(stripCommonRoot(entries)).toEqual(entries);
  });
  it('leaves top-level files alone', () => {
    const entries = [entry('main.tex'), entry('a/y.tex')];
    expect(stripCommonRoot(entries)).toEqual(entries);
  });
});

describe('detectMainFile', () => {
  it('prefers main.tex even when it only \\inputs the real preamble', () => {
    expect(detectMainFile([entry('Template.tex', '\\documentclass{article}'), entry('main.tex', '\\input{Template.tex}')])).toBe('main.tex');
  });
  it('falls back to the shallowest file with \\documentclass', () => {
    const files = [entry('sec/intro.tex', 'text'), entry('sub/paper.tex', '\\documentclass{article}'), entry('paper.tex', '\\documentclass{article}')];
    expect(detectMainFile(files)).toBe('paper.tex');
  });
  it('ignores commented-out \\documentclass', () => {
    const files = [entry('a.tex', '% \\documentclass{article}'), entry('b.tex', '\\documentclass{article}')];
    expect(detectMainFile(files)).toBe('b.tex');
  });
  it('returns null without .tex files', () => {
    expect(detectMainFile([entry('readme.md')])).toBeNull();
  });
});

describe('buildZip', () => {
  it('round-trips through readZipEntries', () => {
    const entries = readZipEntries(buildZip([entry('main.tex', 'hello'), entry('figs/a.txt', 'a')]));
    expect(Object.fromEntries(entries.map((e) => [e.path, e.data.toString()]))).toEqual({ 'main.tex': 'hello', 'figs/a.txt': 'a' });
  });
});
