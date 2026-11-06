import { h, icon, formatBytes } from '../dom.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i;

/** Turn the flat [{ path, type, size }] list into a nested tree, folders first. */
export function buildTree(entries) {
  const root = { name: '', path: '', type: 'dir', children: [] };
  const dirs = new Map([['', root]]);
  const ensureDir = (path) => {
    if (dirs.has(path)) return dirs.get(path);
    const idx = path.lastIndexOf('/');
    const parent = ensureDir(idx === -1 ? '' : path.slice(0, idx));
    const node = { name: path.slice(idx + 1), path, type: 'dir', children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const entry of entries) {
    if (entry.type === 'dir') {
      ensureDir(entry.path);
      continue;
    }
    const idx = entry.path.lastIndexOf('/');
    const parent = ensureDir(idx === -1 ? '' : entry.path.slice(0, idx));
    parent.children.push({ name: entry.path.slice(idx + 1), path: entry.path, type: 'file', size: entry.size });
  }
  const sort = (node) => {
    node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
    node.children.forEach((c) => c.type === 'dir' && sort(c));
  };
  sort(root);
  return root;
}

/** Collapsible project file tree with per-row actions and drag-and-drop upload. */
export class FileTree {
  constructor(container, actions) {
    this.actions = actions;
    this.expanded = new Set();
    this.entries = [];
    this.active = null;
    this.mainFile = null;
    this.selectedDir = '';
    this.listEl = h('div', { class: 'tree-list', role: 'tree' });
    const toolbar = h('div', { class: 'tree-toolbar' },
      h('span', { class: 'tree-title' }, 'Files'),
      h('button', { class: 'icon-btn', title: 'New file', onclick: () => actions.onNewFile(this.selectedDir) }, icon('plus')),
      h('button', { class: 'icon-btn', title: 'New folder', onclick: () => actions.onNewFolder(this.selectedDir) }, icon('folderPlus')),
      h('button', { class: 'icon-btn', title: 'Upload files', onclick: () => this.#pickUpload() }, icon('upload')));
    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => {
      if (this.fileInput.files.length) actions.onUpload([...this.fileInput.files], this.selectedDir);
      this.fileInput.value = '';
    } });
    container.append(toolbar, this.listEl, this.fileInput);
    this.#enableDrop(container);
  }

  #pickUpload() {
    this.fileInput.click();
  }

  #enableDrop(el) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target');
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const row = e.target.closest?.('[data-dir]');
      this.actions.onUpload([...e.dataTransfer.files], row?.dataset.dir ?? this.selectedDir);
    });
  }

  /** Re-render with a new file list; expands folders that contain the active file. */
  render(entries, { active = this.active, mainFile = this.mainFile } = {}) {
    this.entries = entries;
    this.active = active;
    this.mainFile = mainFile;
    if (active) {
      const parts = active.split('/');
      for (let i = 1; i < parts.length; i += 1) this.expanded.add(parts.slice(0, i).join('/'));
    }
    const tree = buildTree(entries);
    this.listEl.replaceChildren(...tree.children.map((n) => this.#node(n, 0)));
  }

  setActive(path) {
    this.render(this.entries, { active: path });
  }

  #node(node, depth) {
    const pad = { paddingLeft: `${8 + depth * 14}px` };
    if (node.type === 'dir') {
      const open = this.expanded.has(node.path);
      const row = h('div', {
        class: `tree-row tree-dir${this.selectedDir === node.path ? ' selected' : ''}`,
        style: pad, role: 'treeitem', 'aria-expanded': String(open), dataset: { dir: node.path }, tabindex: 0,
        onclick: () => {
          if (open) this.expanded.delete(node.path);
          else this.expanded.add(node.path);
          this.selectedDir = node.path;
          this.render(this.entries);
        },
      },
      h('span', { class: `chev${open ? ' open' : ''}` }, icon('chevron')), icon('folder'),
      h('span', { class: 'tree-name' }, node.name),
      this.#rowActions(node));
      const kids = open ? node.children.map((c) => this.#node(c, depth + 1)) : [];
      return h('div', { class: 'tree-group' }, row, ...kids);
    }
    const isMain = node.path === this.mainFile;
    const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    return h('div', {
      class: `tree-row tree-file${node.path === this.active ? ' active' : ''}`,
      style: pad, role: 'treeitem', tabindex: 0, title: `${node.path} (${formatBytes(node.size ?? 0)})`,
      dataset: { dir },
      onclick: () => {
        this.selectedDir = dir;
        this.actions.onOpen(node.path);
      },
      onkeydown: (e) => e.key === 'Enter' && this.actions.onOpen(node.path),
    },
    h('span', { class: 'chev-spacer' }), icon(IMAGE_EXT.test(node.name) ? 'image' : 'file'),
    h('span', { class: 'tree-name' }, node.name),
    isMain ? h('span', { class: 'badge', title: 'Main document' }, 'main') : null,
    this.#rowActions(node));
  }

  #rowActions(node) {
    const stop = (fn) => (e) => {
      e.stopPropagation();
      fn();
    };
    const canBeMain = node.type === 'file' && node.path.endsWith('.tex') && node.path !== this.mainFile;
    return h('span', { class: 'row-actions' },
      canBeMain ? h('button', { class: 'icon-btn sm', title: 'Set as main document', onclick: stop(() => this.actions.onSetMain(node.path)) }, icon('star')) : null,
      h('button', { class: 'icon-btn sm', title: 'Rename / move', onclick: stop(() => this.actions.onRename(node.path)) }, icon('edit')),
      h('button', { class: 'icon-btn sm', title: 'Delete', onclick: stop(() => this.actions.onDelete(node.path, node.type)) }, icon('trash')));
  }
}
