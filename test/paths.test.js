import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { normalizeRelPath, resolveInside, isTextFile } from '../server/paths.js';

describe('normalizeRelPath', () => {
  it.each([
    ['main.tex', 'main.tex'],
    ['./figs/a.png', 'figs/a.png'],
    ['figs\\sub\\a.png', 'figs/sub/a.png'],
    ['/leading/slash.tex', 'leading/slash.tex'],
    ['a/b/../c.tex', 'a/c.tex'],
    ['FO-TEX Template With Spaces.tex', 'FO-TEX Template With Spaces.tex'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRelPath(input)).toBe(expected);
  });

  it.each(['', '   ', '..', '../x', 'a/../../x', 'C:/Windows/x', 'a/b:c', 'bad\u0000name', 'what?.tex'])(
    'rejects %j',
    (input) => {
      expect(() => normalizeRelPath(input)).toThrow();
    },
  );

  it('rejects non-strings', () => {
    expect(() => normalizeRelPath(undefined)).toThrow(/required/);
    expect(() => normalizeRelPath(42)).toThrow();
  });
});

describe('resolveInside', () => {
  const base = path.resolve('/tmp/project');
  it('resolves inside the base directory', () => {
    expect(resolveInside(base, 'figs/a.png')).toBe(path.join(base, 'figs', 'a.png'));
  });
  it('refuses traversal', () => {
    expect(() => resolveInside(base, '../outside.tex')).toThrow(/outside/);
  });
});

describe('isTextFile', () => {
  it('uses the extension when known', () => {
    expect(isTextFile('main.tex')).toBe(true);
    expect(isTextFile('refs.BIB')).toBe(true);
    expect(isTextFile('.latexmkrc')).toBe(true);
    expect(isTextFile('fig.png', Buffer.from('abc'))).toBe(false);
    expect(isTextFile('fig.pdf', Buffer.from('%PDF-1.5'))).toBe(false);
  });
  it('sniffs unknown extensions for NUL bytes', () => {
    expect(isTextFile('notes.unknown', Buffer.from('plain text'))).toBe(true);
    expect(isTextFile('blob.bin', Buffer.from([1, 0, 2]))).toBe(false);
    expect(isTextFile('blob.bin')).toBe(false);
  });
});
