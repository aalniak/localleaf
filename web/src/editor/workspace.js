import { api } from '../api.js';
import { h, icon, toast, askText, askConfirm, store, formatBytes } from '../dom.js';
import { CodeEditor } from './codeEditor.js';
import { PdfViewer } from './pdfViewer.js';
import { FileTree } from './fileTree.js';
import { LogPanel } from './logPanel.js';
import { DocumentSaver } from './documents.js';
import { createLayout } from './layout.js';
import { extractKeys } from './completions.js';
import { createToolbar } from './toolbar.js';

const INDEXED = /\.(tex|bib)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** The project editor: file tree, CodeMirror, PDF preview, logs and compile flow. */
export async function openWorkspace(root, projectId) {
  const [project, health] = await Promise.all([api.getProject(projectId), api.health()]);
  const state = {
    project,
    tree: project.tree,
    path: null,
    result: null,
    compiling: false,
    queued: false,
    draft: store.get(`draft:${projectId}`, false),
    autoCompile: store.get('autoCompile', false),
    keyIndex: new Map(),
  };
  document.title = `${project.name} · Localleaf`;

  const layout = createLayout();
  const saver = new DocumentSaver(projectId, { onState: (s, msg) => setSaveState(s, msg) });

  // ---- editor column -------------------------------------------------------
  const pathLabel = h('span', { class: 'editor-path' }, '');
  const saveLabel = h('span', { class: 'save-state' }, '');
  const editorHost = h('div', { class: 'editor-host' });
  const binaryHost = h('div', { class: 'binary-preview', hidden: true });
  layout.editor.append(h('div', { class: 'pane-header' }, pathLabel, saveLabel,
    h('button', { class: 'icon-btn', title: 'Show this line in the PDF (Ctrl+Alt+→)', onclick: () => syncToPdf() }, icon('right'))),
  editorHost, binaryHost);

  const getIndex = () => {
    const labels = new Set();
    const cites = new Set();
    for (const k of state.keyIndex.values()) {
      k.labels.forEach((l) => labels.add(l));
      k.cites.forEach((c) => cites.add(c));
    }
    return { labels: [...labels].sort(), cites: [...cites].sort() };
  };

  const editor = new CodeEditor(editorHost, {
    getIndex,
    onChange: (path, content) => {
      saver.queue(path, content);
      if (INDEXED.test(path)) state.keyIndex.set(path, extractKeys(path, content));
      if (state.autoCompile) scheduleAutoCompile();
    },
    onSave: () => compile(),
    onCompile: () => compile(),
    onSyncToPdf: () => syncToPdf(),
  });

  // ---- preview column ------------------------------------------------------
  const pdfHost = h('div', { class: 'pdf-host' });
  const logHost = h('div', { class: 'log-host', hidden: true });
  const zoomLabel = h('span', { class: 'zoom-label' }, 'Fit');
  const logBadge = h('span', { class: 'count-badge', hidden: true }, '');
  const tabPdf = h('button', { class: 'tab active', onclick: () => showTab('pdf') }, icon('pdf'), 'PDF');
  const tabLog = h('button', { class: 'tab', onclick: () => showTab('log') }, icon('log'), 'Logs', logBadge);
  const pdf = new PdfViewer(pdfHost, {
    onSyncClick: (pos) => syncFromPdf(pos),
    onZoomChange: (scale, zoom) => {
      zoomLabel.textContent = zoom === 'fit' ? `Fit (${Math.round(scale * 100)}%)` : `${Math.round(scale * 100)}%`;
    },
  });
  layout.preview.append(
    h('div', { class: 'pane-header' }, tabPdf, tabLog, h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Zoom out', onclick: () => pdf.zoomBy(1 / 1.2) }, icon('zoomOut')),
      zoomLabel,
      h('button', { class: 'icon-btn', title: 'Zoom in', onclick: () => pdf.zoomBy(1.2) }, icon('zoomIn')),
      h('button', { class: 'icon-btn', title: 'Fit width', onclick: () => pdf.setZoom('fit') }, icon('fit'))),
    pdfHost, logHost);
  const logPanel = new LogPanel(logHost, { onJump: (file, line) => openFile(file, line) });
  logPanel.render(null);

  function showTab(tab) {
    tabPdf.classList.toggle('active', tab === 'pdf');
    tabLog.classList.toggle('active', tab === 'log');
    pdfHost.hidden = tab !== 'pdf';
    logHost.hidden = tab !== 'log';
  }

  // ---- file tree -----------------------------------------------------------
  const tree = new FileTree(layout.tree, {
    onOpen: (path) => openFile(path),
    onNewFile: (dir) => newFile(dir),
    onNewFolder: (dir) => newFolder(dir),
    onUpload: (files, dir) => uploadFiles(files, dir),
    onRename: (path) => renameEntry(path),
    onDelete: (path, type) => deleteEntry(path, type),
    onSetMain: (path) => updateSettings({ mainFile: path }),
  });

  // ---- toolbar -------------------------------------------------------------
  const toolbar = createToolbar({
    project,
    health,
    state,
    onRename: () => renameProject(),
    onSettings: (patch) => updateSettings(patch),
    onCompile: (opts) => compile(opts),
    onToggleDraft: (on) => {
      state.draft = on;
      store.set(`draft:${projectId}`, on);
    },
    onToggleAuto: (on) => {
      state.autoCompile = on;
      store.set('autoCompile', on);
    },
  });

  root.replaceChildren(h('div', { class: 'workspace' }, toolbar.el, layout.grid));

  function setSaveState(s, message) {
    const labels = { unsaved: 'Unsaved changes…', saving: 'Saving…', saved: 'All changes saved', error: 'Save failed' };
    saveLabel.textContent = labels[s] ?? '';
    saveLabel.className = `save-state save-${s}`;
    if (message) toast(message, 'error', 8000);
  }

  // ---- files ---------------------------------------------------------------
  async function refreshTree() {
    const fresh = await api.getProject(projectId);
    state.project = fresh;
    state.tree = fresh.tree;
    tree.render(state.tree, { active: state.path, mainFile: fresh.mainFile });
    toolbar.update(fresh);
  }

  async function openFile(path, line) {
    try {
      if (!state.tree.some((e) => e.path === path && e.type === 'file')) {
        toast(`"${path}" is not a file in this project`, 'error');
        return;
      }
      if (path !== state.path) {
        if (editor.has(path)) {
          showEditor(path);
        } else {
          const file = await api.readFile(projectId, path);
          if (!file.editable) {
            showBinary(file);
            return;
          }
          saver.markSaved(path, file.content);
          showEditor(path, file.content);
        }
      }
      if (line) editor.goto(line);
    } catch (err) {
      toast(`Could not open ${path}: ${err.message}`, 'error');
    }
  }

  function showEditor(path, content) {
    editor.open(path, content);
    binaryHost.hidden = true;
    editorHost.hidden = false;
    state.path = path;
    pathLabel.textContent = path;
    tree.setActive(path);
    store.set(`open:${projectId}`, path);
    if (state.result) editor.showDiagnostics([...state.result.errors, ...state.result.warnings]);
  }

  function showBinary(file) {
    editor.close();
    state.path = file.path;
    pathLabel.textContent = file.path;
    tree.setActive(file.path);
    editorHost.hidden = true;
    binaryHost.hidden = false;
    const url = api.rawUrl(projectId, file.path);
    const body = IMAGE.test(file.path)
      ? h('img', { src: url, alt: file.path })
      : h('p', {}, file.path.endsWith('.pdf') ? 'PDF figure. ' : 'This file cannot be edited as text. ',
        h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open / download'));
    binaryHost.replaceChildren(h('div', { class: 'binary-meta' }, `${file.path} · ${formatBytes(file.size)}`), body);
  }

  async function newFile(dir) {
    const name = await askText('New file', { value: dir ? `${dir}/` : '', placeholder: 'chapter.tex', confirmLabel: 'Create' });
    if (!name) return;
    try {
      const { path } = await api.writeFile(projectId, name, '');
      await refreshTree();
      await openFile(path);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function newFolder(dir) {
    const name = await askText('New folder', { value: dir ? `${dir}/` : '', placeholder: 'figures', confirmLabel: 'Create' });
    if (!name) return;
    try {
      await api.createFolder(projectId, name);
      await refreshTree();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function uploadFiles(files, dir) {
    try {
      const { paths } = await api.upload(projectId, files, dir);
      const replacedActive = paths.includes(state.path);
      paths.forEach((p) => editor.forget(p));
      toast(`Uploaded ${paths.length} file${paths.length === 1 ? '' : 's'}`, 'success');
      await refreshTree();
      if (replacedActive) {
        const reopen = state.path;
        state.path = null;
        await openFile(reopen); // show the uploaded content instead of a stale buffer
      }
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'error');
    }
  }

  async function renameEntry(path) {
    const to = await askText('Rename or move (use / for folders)', { value: path, confirmLabel: 'Rename' });
    if (!to || to === path) return;
    try {
      await saver.flush();
      const { path: newPath } = await api.move(projectId, path, to);
      editor.rename(path, newPath);
      saver.rename(path, newPath);
      for (const key of [...state.keyIndex.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) {
          state.keyIndex.set(newPath + key.slice(path.length), state.keyIndex.get(key));
          state.keyIndex.delete(key);
        }
      }
      if (state.path && (state.path === path || state.path.startsWith(`${path}/`))) {
        state.path = newPath + state.path.slice(path.length);
        pathLabel.textContent = state.path;
      }
      await refreshTree();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteEntry(path, type) {
    const confirmed = await askConfirm(`Delete ${type === 'dir' ? 'folder' : 'file'}?`, `"${path}" will be permanently deleted from this project.`);
    if (!confirmed) return;
    try {
      saver.forget(path); // cancel queued saves first so none can recreate the file
      await saver.flush(); // and let any in-flight save settle before deleting
      await api.deleteEntry(projectId, path);
      editor.forget(path);
      for (const key of [...state.keyIndex.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) state.keyIndex.delete(key);
      }
      if (state.path === path || state.path?.startsWith(`${path}/`)) {
        state.path = null;
        pathLabel.textContent = '';
        editorHost.hidden = true;
        binaryHost.hidden = true;
      }
      await refreshTree();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---- project settings ----------------------------------------------------
  async function renameProject() {
    const name = await askText('Rename project', { value: state.project.name, confirmLabel: 'Rename' });
    if (name) await updateSettings({ name });
  }

  async function updateSettings(patch) {
    try {
      const meta = await api.updateProject(projectId, patch);
      state.project = { ...state.project, ...meta };
      toolbar.update(state.project);
      tree.render(state.tree, { mainFile: meta.mainFile });
      document.title = `${meta.name} · Localleaf`;
    } catch (err) {
      toast(err.message, 'error');
      toolbar.update(state.project);
    }
  }

  // ---- compile -------------------------------------------------------------
  let autoTimer = null;
  function scheduleAutoCompile() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => compile({ auto: true }), 2500);
  }

  async function compile({ fromScratch = false, auto = false } = {}) {
    if (state.compiling) {
      state.queued = true;
      return;
    }
    state.compiling = true;
    state.compiledThisSession = true;
    toolbar.setCompiling(true);
    try {
      const saved = await saver.flush();
      if (!saved && auto) return;
      if (fromScratch) await api.clearCache(projectId);
      const result = await api.compile(projectId, { draft: state.draft });
      await applyResult(result, { switchToLogs: !auto });
    } catch (err) {
      if (err.status === 409) {
        toast('This project is already compiling (another tab?). Try again when it finishes.');
      } else {
        toast(err.message, 'error', 10000);
        logPanel.render({ status: 'failure', errors: [], warnings: [], typesetting: [], log: '', output: err.message });
      }
    } finally {
      state.compiling = false;
      toolbar.setCompiling(false);
      if (state.queued) {
        state.queued = false;
        compile({ auto: true });
      }
    }
  }

  async function applyResult(result, { switchToLogs }) {
    state.result = result;
    logPanel.render(result);
    const problems = result.errors.length;
    logBadge.hidden = problems + result.warnings.length === 0;
    logBadge.textContent = String(problems || result.warnings.length);
    logBadge.className = `count-badge ${problems ? 'err' : 'warn'}`;
    if (editor.path) editor.showDiagnostics([...result.errors, ...result.warnings]);
    if (result.pdf) {
      try {
        await pdf.load(result.pdf.url);
      } catch (err) {
        pdf.clear(`Could not display the PDF: ${err.message}`);
      }
    } else if (result.status !== 'none') {
      pdf.clear('No PDF was produced. See the logs for details.');
    }
    if (switchToLogs && (!result.pdf || result.errors.length)) showTab('log');
    else if (result.pdf) showTab('pdf');
  }

  // ---- SyncTeX -------------------------------------------------------------
  async function syncToPdf() {
    if (!editor.path || !health.supportsSynctex) return;
    const { line, column } = editor.cursor();
    try {
      const boxes = await api.syncView(projectId, editor.path, line, column);
      if (!boxes.length) {
        toast('No matching location in the PDF (recompile first?)');
        return;
      }
      showTab('pdf');
      pdf.highlight(boxes[0]);
    } catch (err) {
      toast(`SyncTeX: ${err.message}`, 'error');
    }
  }

  async function syncFromPdf({ page, x, y }) {
    if (!health.supportsSynctex) return;
    try {
      const target = await api.syncEdit(projectId, page, x, y);
      if (!target) {
        toast('That spot does not map to a project source file');
        return;
      }
      await openFile(target.file, target.line);
    } catch (err) {
      toast(`SyncTeX: ${err.message}`, 'error');
    }
  }

  // ---- global shortcuts & lifecycle -----------------------------------------
  const onKey = (e) => {
    // CodeMirror handles these itself (and calls preventDefault); don't compile twice.
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      compile();
    }
  };
  const onUnload = (e) => {
    if (saver.hasPending()) {
      saver.flush();
      e.preventDefault();
    }
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onUnload);

  // Initial content: tree, last open file, existing PDF, label index.
  tree.render(state.tree, { mainFile: project.mainFile });
  const remembered = store.get(`open:${projectId}`, null);
  const first = [remembered, project.mainFile].find((p) => p && state.tree.some((e) => e.path === p));
  if (first) await openFile(first);
  pdf.showMessage(project.mainFile ? 'Press Recompile (Ctrl+S) to build the PDF.' : 'Choose a main document to compile.');
  api.lastCompile(projectId)
    .then((last) => {
      // Skip if a compile already started: its result is newer than what is on disk now.
      if (last.status !== 'none' && !state.compiledThisSession) applyResult(last, { switchToLogs: false });
    })
    .catch((err) => pdf.showMessage(`Could not load the previous PDF: ${err.message}`));
  buildKeyIndex();

  async function buildKeyIndex() {
    const sources = state.tree.filter((e) => e.type === 'file' && INDEXED.test(e.path));
    for (const file of sources) {
      try {
        const { content, editable } = await api.readFile(projectId, file.path);
        if (editable) state.keyIndex.set(file.path, extractKeys(file.path, content));
      } catch {
        /* indexing is best-effort; completion simply lacks this file's keys */
      }
    }
  }

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    clearTimeout(autoTimer);
    if (saver.hasPending()) saver.flush();
    pdf.clear('');
  };
}
