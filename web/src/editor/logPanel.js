import { h } from '../dom.js';

const STATUS_TEXT = {
  success: 'Compiled successfully',
  error: 'Compiled with errors',
  failure: 'Compile failed: no PDF was produced',
  timeout: 'Compile timed out',
  none: 'Not compiled yet',
};

/** Overleaf-style list of errors / warnings / bad boxes, plus the raw log. */
export class LogPanel {
  constructor(container, { onJump }) {
    this.onJump = onJump;
    this.el = h('div', { class: 'log-panel' });
    container.append(this.el);
    this.showRaw = false;
    this.result = null;
  }

  render(result) {
    this.result = result;
    if (!result) {
      this.el.replaceChildren(h('p', { class: 'muted pad' }, 'Compile the project to see logs here.'));
      return;
    }
    const { errors = [], warnings = [], typesetting = [] } = result;
    const header = h('div', { class: `log-status status-${result.status}` },
      h('strong', {}, STATUS_TEXT[result.status] ?? result.status),
      result.durationMs ? h('span', { class: 'muted' }, ` in ${(result.durationMs / 1000).toFixed(1)} s`) : null,
      result.draft ? h('span', { class: 'badge' }, 'draft') : null);
    const sections = [
      this.#section('Errors', errors),
      this.#section('Warnings', warnings),
      this.#section('Bad boxes', typesetting),
    ];
    const emptyNote = errors.length + warnings.length + typesetting.length === 0 && result.status !== 'none'
      ? h('p', { class: 'muted pad' }, 'No errors or warnings.')
      : null;
    const rawToggle = h('button', {
      class: 'btn btn-sm',
      onclick: () => {
        this.showRaw = !this.showRaw;
        this.render(this.result);
      },
    }, this.showRaw ? 'Hide raw logs' : 'Show raw logs');
    const raw = this.showRaw
      ? h('pre', { class: 'raw-log' }, result.log || result.output || '(empty log)')
      : null;
    const output = (result.status === 'failure' || result.status === 'timeout') && result.output
      ? h('details', { class: 'compiler-output', open: !result.log }, h('summary', {}, 'Compiler output'), h('pre', { class: 'raw-log' }, result.output))
      : null;
    this.el.replaceChildren(header, ...sections, emptyNote, output, h('div', { class: 'pad' }, rawToggle), raw);
  }

  #section(title, entries) {
    if (!entries.length) return null;
    const MAX = 300;
    return h('div', { class: 'log-section' },
      h('h4', {}, `${title} (${entries.length})`),
      entries.slice(0, MAX).map((e) => this.#entry(e)),
      entries.length > MAX ? h('p', { class: 'muted pad' }, `…and ${entries.length - MAX} more (see raw logs)`) : null);
  }

  #entry(entry) {
    const where = entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}` : null;
    const jumpable = Boolean(entry.file && entry.line);
    return h('div', {
      class: `log-entry level-${entry.level}${jumpable ? ' clickable' : ''}`,
      title: jumpable ? 'Go to this line' : '',
      onclick: jumpable ? () => this.onJump(entry.file, entry.line) : null,
    },
    h('div', { class: 'log-entry-head' },
      h('span', { class: 'log-message' }, entry.message),
      where ? h('span', { class: 'log-where' }, where) : null),
    entry.content && entry.level === 'error' ? h('pre', { class: 'log-content' }, entry.content) : null);
  }
}
