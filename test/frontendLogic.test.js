import { describe, it, expect } from 'vitest';
import { buildTree } from '../web/src/editor/fileTree.js';
import { latexCompletionSource, extractKeys } from '../web/src/editor/completions.js';

describe('buildTree', () => {
  it('nests files under folders, folders first, natural order', () => {
    const tree = buildTree([
      { path: 'b.tex', type: 'file', size: 1 },
      { path: 'figs/fig10.png', type: 'file', size: 1 },
      { path: 'figs/fig2.png', type: 'file', size: 1 },
      { path: 'a.tex', type: 'file', size: 1 },
      { path: 'empty', type: 'dir' },
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(['empty', 'figs', 'a.tex', 'b.tex']);
    expect(tree.children[1].children.map((c) => c.name)).toEqual(['fig2.png', 'fig10.png']);
  });

  it('creates implicit parent folders', () => {
    const tree = buildTree([{ path: 'a/b/c.tex', type: 'file', size: 1 }]);
    expect(tree.children[0]).toMatchObject({ name: 'a', type: 'dir' });
    expect(tree.children[0].children[0].children[0]).toMatchObject({ path: 'a/b/c.tex' });
  });
});

describe('extractKeys', () => {
  it('finds labels and bibitems in .tex', () => {
    const src = '\\section{A}\\label{sec:a}\n\\begin{thebibliography}{9}\\bibitem{baker} x \\bibitem[Q18]{vins} y';
    expect(extractKeys('main.tex', src)).toEqual({ labels: ['sec:a'], cites: ['baker', 'vins'] });
  });
  it('finds BibTeX keys in .bib', () => {
    expect(extractKeys('refs.bib', '@article{knuth84,\n title={x}}\n@book{ lamport94 , }')).toEqual({ labels: [], cites: ['knuth84', 'lamport94'] });
  });
});

/** Minimal stand-in for CodeMirror's CompletionContext. */
function contextFor(text, explicit = false) {
  return {
    explicit,
    matchBefore(re) {
      const m = new RegExp(`(?:${re.source})$`).exec(text);
      return m ? { from: m.index, to: text.length, text: m[0] } : null;
    },
  };
}

describe('latexCompletionSource', () => {
  const source = latexCompletionSource(() => ({ labels: ['sec:a', 'fig:b'], cites: ['baker'] }));

  it('completes labels inside \\ref{', () => {
    const res = source(contextFor('see \\ref{se'));
    expect(res.from).toBe('see \\ref{'.length);
    expect(res.options.map((o) => o.label)).toEqual(['sec:a', 'fig:b']);
  });

  it('completes citation keys after a comma in \\cite{', () => {
    const res = source(contextFor('\\cite{x,ba'));
    expect(res.from).toBe('\\cite{x,'.length);
    expect(res.options.map((o) => o.label)).toEqual(['baker']);
  });

  it('completes environments after \\begin{', () => {
    const res = source(contextFor('\\begin{ite'));
    expect(res.from).toBe('\\begin{'.length);
    expect(res.options.some((o) => o.label === 'itemize')).toBe(true);
  });

  it('completes commands after a backslash and stays quiet otherwise', () => {
    const res = source(contextFor('text \\sec'));
    expect(res.from).toBe(5);
    expect(res.options.some((o) => o.label === '\\section')).toBe(true);
    expect(source(contextFor('plain text'))).toBeNull();
  });
});
