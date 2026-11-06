import { describe, it, expect } from 'vitest';
import { parseSynctexView, parseSynctexEdit } from '../server/compiler/synctex.js';

const VIEW = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/work/a/out/main.pdf
Page:11
x:75.35
y:355.30
h:56.302399
v:357.425781
W:484.395477
H:9.633992
before:
offset:-1
middle:
after:
Output:/work/a/out/main.pdf
Page:11
x:86.6
y:368.8
h:56.69
v:370.97
W:481.88
H:9.63
SyncTeX result end
`;

const edit = (input) => `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/work/a/out/main.pdf
Input:${input}
Line:31
Column:-1
Offset:0
Context:
SyncTeX result end
`;

describe('parseSynctexView', () => {
  it('parses every record', () => {
    const boxes = parseSynctexView(VIEW);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual({ page: 11, h: 56.302399, v: 357.425781, width: 484.395477, height: 9.633992 });
  });
  it('returns [] for empty / garbage output', () => {
    expect(parseSynctexView('')).toEqual([]);
    expect(parseSynctexView('SyncTeX ERROR')).toEqual([]);
  });
});

describe('parseSynctexEdit', () => {
  it('maps container paths back to project paths', () => {
    expect(parseSynctexEdit(edit('/work/a/src/./sections/general.tex'), '/work/a/src')).toEqual({ file: 'sections/general.tex', line: 31, column: 0 });
  });
  it('returns null for generated or system files', () => {
    expect(parseSynctexEdit(edit('/work/a/out/main.toc'), '/work/a/src')).toBeNull();
    expect(parseSynctexEdit('nothing', '/work/a/src')).toBeNull();
  });
});
