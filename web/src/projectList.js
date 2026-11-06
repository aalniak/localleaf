import { api } from './api.js';
import { h, icon, toast, askText, askConfirm, timeAgo } from './dom.js';

/** Dashboard: list, create, import (.zip), rename, download and delete projects. */
export async function openProjectList(root) {
  document.title = 'Projects · Localleaf';
  const zipInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => {
    if (zipInput.files[0]) importZip(zipInput.files[0]);
    zipInput.value = '';
  } });
  const listEl = h('div', { class: 'project-list' });
  const status = h('div', { class: 'compiler-status muted' });
  const dropZone = h('div', { class: 'drop-zone' },
    icon('upload'), h('span', {}, 'Drop an Overleaf/LaTeX .zip here to import it'));

  root.replaceChildren(h('div', { class: 'dashboard' },
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, icon('home'), h('span', {}, 'Localleaf')),
      h('span', { class: 'spacer' }), status),
    h('main', { class: 'dashboard-body' },
      h('div', { class: 'dashboard-actions' },
        h('h1', {}, 'Projects'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => zipInput.click() }, icon('upload'), 'Upload .zip'),
        h('button', { class: 'btn btn-primary', onclick: () => newProject() }, icon('plus'), 'New project')),
      dropZone, listEl, zipInput)));

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('active');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('active');
    const file = e.dataTransfer?.files[0];
    if (file) importZip(file);
  });

  api.health().then(
    (hl) => { status.textContent = `Compiler: ${hl.description}`; },
    () => { status.textContent = 'Server unreachable'; },
  );

  async function refresh() {
    try {
      const projects = await api.listProjects();
      if (!projects.length) {
        listEl.replaceChildren(h('p', { class: 'muted empty' }, 'No projects yet. Create one or upload a .zip exported from Overleaf.'));
        return;
      }
      listEl.replaceChildren(h('table', { class: 'projects-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Main document'), h('th', {}, 'Last modified'), h('th', {}, ''))),
        h('tbody', {}, projects.map(row))));
    } catch (err) {
      listEl.replaceChildren(h('p', { class: 'error' }, err.message));
    }
  }

  function row(p) {
    return h('tr', {},
      h('td', {}, h('a', { href: `#/project/${p.id}`, class: 'project-link' }, p.name)),
      h('td', { class: 'muted' }, p.mainFile ?? '-'),
      h('td', { class: 'muted' }, timeAgo(p.updatedAt)),
      h('td', { class: 'row-buttons' },
        h('button', { class: 'icon-btn', title: 'Rename', onclick: () => rename(p) }, icon('edit')),
        h('a', { class: 'icon-btn', title: 'Download source .zip', href: api.downloadUrl(p.id) }, icon('download')),
        h('button', { class: 'icon-btn', title: 'Delete', onclick: () => remove(p) }, icon('trash'))));
  }

  async function newProject() {
    const name = await askText('New project', { placeholder: 'My paper', confirmLabel: 'Create' });
    if (!name) return;
    try {
      const p = await api.createProject(name);
      location.hash = `#/project/${p.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function importZip(file) {
    if (!/\.zip$/i.test(file.name)) {
      toast('Please choose a .zip file', 'error');
      return;
    }
    toast(`Importing ${file.name}…`);
    try {
      const p = await api.importZip(file);
      toast(`Imported "${p.name}"`, 'success');
      location.hash = `#/project/${p.id}`;
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error', 8000);
    }
  }

  async function rename(p) {
    const name = await askText('Rename project', { value: p.name, confirmLabel: 'Rename' });
    if (!name) return;
    try {
      await api.updateProject(p.id, { name });
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function remove(p) {
    if (!(await askConfirm('Delete project?', `"${p.name}" and all its files will be permanently deleted.`))) return;
    try {
      await api.deleteProject(p.id);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  await refresh();
  return () => {};
}
