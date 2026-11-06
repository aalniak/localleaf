import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { latexCompletionSource } from './completions.js';

const LATEX_EXT = /\.(tex|sty|cls|ltx|dtx|bib|bbx|cbx|def|clo|tikz)$/i;

/**
 * CodeMirror wrapper that keeps one EditorState per open file, so switching
 * files preserves undo history, selection and scroll position.
 */
export class CodeEditor {
  constructor(parent, { onChange, onSave, onCompile, onSyncToPdf, getIndex }) {
    this.handlers = { onChange, onSave, onCompile, onSyncToPdf };
    this.getIndex = getIndex;
    this.states = new Map();
    this.scrolls = new Map();
    this.path = null;
    this.view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: [EditorState.readOnly.of(true)] }) });
  }

  #extensions(path) {
    const run = (fn) => () => {
      fn?.();
      return true;
    };
    const shortcuts = Prec.highest(
      keymap.of([
        { key: 'Mod-s', run: run(this.handlers.onSave) },
        { key: 'Mod-Enter', run: run(this.handlers.onCompile) },
        { key: 'Mod-Alt-ArrowRight', run: run(this.handlers.onSyncToPdf) },
      ]),
    );
    return [
      basicSetup,
      shortcuts,
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
      lintGutter(),
      LATEX_EXT.test(path) ? StreamLanguage.define(stex) : [],
      autocompletion({ override: [latexCompletionSource(this.getIndex)], activateOnTyping: true }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && this.path === path) this.handlers.onChange?.(path, update.state.doc.toString());
      }),
    ];
  }

  has(path) {
    return this.states.has(path);
  }

  /** Show a file. `content` is only used the first time a path is opened. */
  open(path, content) {
    this.#stash();
    const state = this.states.get(path) ?? EditorState.create({ doc: content ?? '', extensions: this.#extensions(path) });
    this.path = path;
    this.view.setState(state);
    const top = this.scrolls.get(path) ?? 0;
    requestAnimationFrame(() => this.view.scrollDOM.scrollTo({ top }));
  }

  /** Detach the current file (e.g. when a binary file is selected). */
  close() {
    this.#stash();
    this.path = null;
  }

  #stash() {
    if (!this.path) return;
    this.states.set(this.path, this.view.state);
    this.scrolls.set(this.path, this.view.scrollDOM.scrollTop);
  }

  /** Content of an open file (current view or stashed state). */
  content(path) {
    if (path === this.path) return this.view.state.doc.toString();
    return this.states.get(path)?.doc.toString() ?? null;
  }

  /**
   * Re-key open files after a rename. Extensions (change listener, language) are
   * bound to the path, so each affected state is rebuilt for its new path,
   * keeping the text and selection.
   */
  rename(from, to) {
    const moved = (key) => key === from || key.startsWith(`${from}/`);
    this.#stash();
    for (const key of [...this.states.keys()].filter(moved)) {
      const next = to + key.slice(from.length);
      const old = this.states.get(key);
      this.states.set(next, EditorState.create({ doc: old.doc, selection: old.selection, extensions: this.#extensions(next) }));
      this.scrolls.set(next, this.scrolls.get(key));
      this.states.delete(key);
      this.scrolls.delete(key);
    }
    if (this.path && moved(this.path)) {
      const target = to + this.path.slice(from.length);
      this.path = null; // already stashed above; keep open() from re-stashing under the old key
      this.open(target);
    }
  }

  forget(path) {
    const gone = (key) => key === path || key.startsWith(`${path}/`);
    if (this.path && gone(this.path)) {
      this.path = null;
      this.view.setState(EditorState.create({ doc: '', extensions: [EditorState.readOnly.of(true)] }));
    }
    for (const key of [...this.states.keys()]) {
      if (gone(key)) {
        this.states.delete(key);
        this.scrolls.delete(key);
      }
    }
    if (this.path === path) this.path = null;
  }

  /** Move the cursor to a 1-based line (and 0-based column) and center it. */
  goto(line, column = 0) {
    const doc = this.view.state.doc;
    const ln = doc.line(Math.min(Math.max(1, line), doc.lines));
    const pos = Math.min(ln.from + Math.max(0, column), ln.to);
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.view.focus();
  }

  cursor() {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number, column: head - line.from };
  }

  /** Show compile diagnostics for the visible file as gutter markers + underlines. */
  showDiagnostics(entries) {
    const doc = this.view.state.doc;
    const diagnostics = entries
      .filter((e) => e.file === this.path && e.line)
      .map((e) => {
        const ln = doc.line(Math.min(e.line, doc.lines));
        return {
          from: ln.from,
          to: ln.to,
          severity: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : 'info',
          message: e.message,
        };
      });
    this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
  }
}
