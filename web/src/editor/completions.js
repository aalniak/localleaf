import { snippetCompletion } from '@codemirror/autocomplete';

const cmd = (name, template, detail) => snippetCompletion(template, { label: `\\${name}`, type: 'keyword', detail });
const plain = (name, detail) => ({ label: `\\${name}`, type: 'keyword', detail });

const COMMANDS = [
  cmd('section', '\\section{${}}', 'heading'),
  cmd('subsection', '\\subsection{${}}', 'heading'),
  cmd('subsubsection', '\\subsubsection{${}}', 'heading'),
  cmd('paragraph', '\\paragraph{${}}', 'heading'),
  cmd('chapter', '\\chapter{${}}', 'heading'),
  cmd('textbf', '\\textbf{${}}', 'bold'),
  cmd('textit', '\\textit{${}}', 'italic'),
  cmd('emph', '\\emph{${}}', 'emphasis'),
  cmd('texttt', '\\texttt{${}}', 'monospace'),
  cmd('underline', '\\underline{${}}'),
  cmd('label', '\\label{${}}'),
  cmd('ref', '\\ref{${}}'),
  cmd('eqref', '\\eqref{${}}'),
  cmd('pageref', '\\pageref{${}}'),
  cmd('cite', '\\cite{${}}'),
  cmd('url', '\\url{${}}'),
  cmd('href', '\\href{${url}}{${text}}'),
  cmd('footnote', '\\footnote{${}}'),
  cmd('caption', '\\caption{${}}'),
  cmd('input', '\\input{${}}'),
  cmd('include', '\\include{${}}'),
  cmd('usepackage', '\\usepackage{${}}'),
  cmd('includegraphics', '\\includegraphics[width=${0.8}\\linewidth]{${}}'),
  cmd('frac', '\\frac{${}}{${}}'),
  cmd('sqrt', '\\sqrt{${}}'),
  cmd('mathrm', '\\mathrm{${}}'),
  cmd('mathbf', '\\mathbf{${}}'),
  cmd('text', '\\text{${}}'),
  cmd('newcommand', '\\newcommand{\\${name}}[${0}]{${}}'),
  cmd('begin', '\\begin{${env}}\n\t${}\n\\end{${env}}', 'environment'),
  plain('item'), plain('hline'), plain('centering'), plain('noindent'), plain('newpage'), plain('clearpage'),
  plain('tableofcontents'), plain('maketitle'), plain('today'), plain('linewidth'), plain('textwidth'),
  plain('alpha'), plain('beta'), plain('gamma'), plain('delta'), plain('theta'), plain('lambda'), plain('mu'),
  plain('sigma'), plain('omega'), plain('psi'), plain('phi'), plain('cdot'), plain('times'), plain('approx'),
  plain('leq'), plain('geq'), plain('neq'), plain('infty'), plain('sum'), plain('int'), plain('partial'),
];

const ENVIRONMENTS = [
  'itemize', 'enumerate', 'description', 'figure', 'table', 'tabular', 'tabularx', 'longtable', 'equation',
  'equation*', 'align', 'align*', 'gather', 'multline', 'center', 'minipage', 'verbatim', 'quote', 'abstract',
  'thebibliography', 'array', 'matrix', 'pmatrix', 'bmatrix', 'cases', 'proof', 'theorem', 'lemma',
];

const envCompletion = (name) =>
  snippetCompletion(`${name}}\n\t\${}\n\\end{${name}}`, { label: name, type: 'type', detail: 'environment' });

/**
 * LaTeX completion source: commands, environments after \begin{, and project
 * labels / citation keys after \ref{ / \cite{ (supplied by getIndex()).
 */
export function latexCompletionSource(getIndex) {
  return (context) => {
    const keyed = context.matchBefore(/\\(?:[a-zA-Z]*ref|cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\])*\{[^}]*/);
    if (keyed) {
      const isCite = /\\(?:cite|nocite)/.test(keyed.text);
      const lastSep = Math.max(keyed.text.lastIndexOf('{'), keyed.text.lastIndexOf(','));
      const index = getIndex();
      const keys = isCite ? index.cites : index.labels;
      return {
        from: keyed.from + lastSep + 1,
        options: keys.map((k) => ({ label: k, type: isCite ? 'text' : 'variable' })),
        validFor: /^[^},]*$/,
      };
    }
    const env = context.matchBefore(/\\begin\{[a-zA-Z*]*/);
    if (env) {
      return { from: env.from + 7, options: ENVIRONMENTS.map(envCompletion), validFor: /^[a-zA-Z*]*$/ };
    }
    const command = context.matchBefore(/\\[a-zA-Z]*/);
    if (!command || (command.from === command.to && !context.explicit)) return null;
    return { from: command.from, options: COMMANDS, validFor: /^\\[a-zA-Z]*$/ };
  };
}

const LABEL_RE = /\\label\{([^}]+)\}/g;
const BIBITEM_RE = /\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g;
const BIBTEX_RE = /@\w+\s*\{\s*([^,\s]+)\s*,/g;

/** Extract \label keys and citation keys from a .tex or .bib source. */
export function extractKeys(path, content) {
  const labels = [];
  const cites = [];
  if (path.endsWith('.bib')) {
    for (const m of content.matchAll(BIBTEX_RE)) cites.push(m[1]);
  } else {
    for (const m of content.matchAll(LABEL_RE)) labels.push(m[1]);
    for (const m of content.matchAll(BIBITEM_RE)) cites.push(m[1]);
  }
  return { labels, cites };
}
