import { describe, it, expect } from 'vitest';
import { parseLatexLog, normalizeLogPath } from '../server/compiler/logParser.js';

const LOG = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.28 (TeX Live 2026) (preloaded format=pdflatex 2026.10.1)  2 NOV 2026 08:00
entering extended mode
(./main.tex ("./FO-TEX Template With Spaces.tex"
LaTeX2e <2025-11-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size11.clo))
(/work/abc/src/general.tex
LaTeX Warning: Reference \`sec:missing' on page 3 undefined on input line 42.

Overfull \hbox (12.3pt too wide) in paragraph at lines 50--52
[]\T1/cmr/m/n/10.95 Some long text|
./general.tex:57: Undefined control sequence.
l.57 \undefinedmacro

The control sequence at the end of the top line
)
(./appendixA.tex
Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing \\' on input line 12.

! Missing $ inserted.
<inserted text>
                $
l.20 a_b

Underfull \vbox (badness 10000) has occurred while \output is active []
)
LaTeX Font Warning: Some font shapes were not available, defaulting to the default shape.
)
`;

describe('parseLatexLog', () => {
  const parsed = parseLatexLog(LOG, { rootPrefixes: ['/work/abc/src'] });

  it('extracts file-line-error errors with context', () => {
    const err = parsed.errors.find((e) => e.message === 'Undefined control sequence.');
    expect(err).toMatchObject({ level: 'error', file: 'general.tex', line: 57 });
    expect(err.content).toContain('l.57 \\undefinedmacro');
  });

  it('attributes "!" errors to the current file and its l.NN line', () => {
    expect(parsed.errors.find((e) => e.message === 'Missing $ inserted.')).toMatchObject({ file: 'appendixA.tex', line: 20 });
  });

  it('tracks files with prefixes stripped and quoted names with spaces', () => {
    const ref = parsed.warnings.find((w) => w.message.includes('sec:missing'));
    expect(ref).toMatchObject({ file: 'general.tex', line: 42 });
    const font = parsed.warnings.find((w) => w.message.startsWith('LaTeX Font Warning'));
    expect(font.file).toBe('FO-TEX Template With Spaces.tex');
  });

  it('joins multi-line package warnings', () => {
    const w = parsed.warnings.find((x) => x.message.startsWith('Package hyperref Warning'));
    expect(w.message).toContain('removing');
    expect(w).toMatchObject({ file: 'appendixA.tex', line: 12 });
  });

  it('collects bad boxes with line numbers when present', () => {
    expect(parsed.typesetting[0]).toMatchObject({ file: 'general.tex', line: 50 });
    expect(parsed.typesetting[1]).toMatchObject({ file: 'appendixA.tex', line: null });
  });

  it('handles empty input', () => {
    expect(parseLatexLog('').all).toEqual([]);
    expect(parseLatexLog(undefined).all).toEqual([]);
  });
});

describe('normalizeLogPath', () => {
  it('strips prefixes and ./', () => {
    expect(normalizeLogPath('/work/x/src/./a/b.tex', ['/work/x/src'])).toBe('a/b.tex');
    expect(normalizeLogPath('././c.tex')).toBe('c.tex');
    expect(normalizeLogPath('C:\\proj\\d.tex', ['C:/proj'])).toBe('d.tex');
    expect(normalizeLogPath(null)).toBeNull();
  });
});
