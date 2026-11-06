import { h, store } from '../dom.js';

/**
 * Three resizable columns (file tree | editor | PDF). Column widths are stored
 * as CSS variables on the grid and remembered in localStorage.
 */
export function createLayout() {
  const tree = h('aside', { class: 'pane pane-tree' });
  const editor = h('section', { class: 'pane pane-editor' });
  const preview = h('section', { class: 'pane pane-preview' });
  const gutterLeft = h('div', { class: 'gutter', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const gutterRight = h('div', { class: 'gutter', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const grid = h('div', { class: 'workspace-grid' }, tree, gutterLeft, editor, gutterRight, preview);

  const widths = { tree: store.get('treeWidth', 230), pdf: store.get('pdfWidth', Math.round(window.innerWidth * 0.45)) };
  const apply = () => {
    grid.style.setProperty('--tree-w', `${widths.tree}px`);
    grid.style.setProperty('--pdf-w', `${widths.pdf}px`);
  };
  apply();

  const drag = (gutter, update) => {
    gutter.addEventListener('pointerdown', (down) => {
      down.preventDefault();
      gutter.setPointerCapture(down.pointerId);
      document.body.classList.add('resizing');
      const move = (e) => {
        update(e.clientX);
        apply();
      };
      const up = () => {
        gutter.removeEventListener('pointermove', move);
        gutter.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
        store.set('treeWidth', widths.tree);
        store.set('pdfWidth', widths.pdf);
      };
      gutter.addEventListener('pointermove', move);
      gutter.addEventListener('pointerup', up);
    });
  };
  drag(gutterLeft, (x) => {
    widths.tree = Math.min(500, Math.max(140, x - grid.getBoundingClientRect().left));
  });
  drag(gutterRight, (x) => {
    const rect = grid.getBoundingClientRect();
    widths.pdf = Math.min(rect.width - widths.tree - 260, Math.max(240, rect.right - x));
  });

  return { grid, tree, editor, preview };
}
