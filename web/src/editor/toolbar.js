import { h, icon } from '../dom.js';
import { api } from '../api.js';

const ENGINES = [
  ['pdflatex', 'pdfLaTeX'],
  ['xelatex', 'XeLaTeX'],
  ['lualatex', 'LuaLaTeX'],
];

/** Top bar: project name, main document, engine, draft/auto toggles, compile + downloads. */
export function createToolbar({ project, health, state, onRename, onSettings, onCompile, onToggleDraft, onToggleAuto }) {
  const nameBtn = h('button', { class: 'project-name', title: 'Rename project', onclick: onRename }, project.name);
  const mainSelect = h('select', { class: 'select', title: 'Main document', onchange: () => onSettings({ mainFile: mainSelect.value }) });
  const engineSelect = h('select', {
    class: 'select', title: 'Compiler', disabled: !health.supportsEngines,
    onchange: () => onSettings({ engine: engineSelect.value }),
  }, ENGINES.map(([value, label]) => h('option', { value }, label)));
  const draftBox = h('input', { type: 'checkbox', checked: state.draft, onchange: () => onToggleDraft(draftBox.checked) });
  const autoBox = h('input', { type: 'checkbox', checked: state.autoCompile, onchange: () => onToggleAuto(autoBox.checked) });
  const compileBtn = h('button', { class: 'btn btn-primary compile-btn', title: 'Save and recompile (Ctrl+S / Ctrl+Enter)', onclick: () => onCompile() },
    icon('play'), h('span', { class: 'compile-label' }, 'Recompile'));
  const scratchBtn = h('button', { class: 'btn', title: 'Delete cached build files (.aux, .toc, …) and compile from scratch', onclick: () => onCompile({ fromScratch: true }) }, 'From scratch');
  const pdfLink = h('a', { class: 'btn', href: `/api/projects/${project.id}/output/pdf`, download: `${project.name}.pdf`, title: 'Download PDF' }, icon('download'), 'PDF');
  const zipLink = h('a', { class: 'btn', href: api.downloadUrl(project.id), title: 'Download project as .zip' }, icon('download'), 'Source');

  const el = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/', title: 'All projects' }, icon('home'), h('span', {}, 'Localleaf')),
    nameBtn,
    h('span', { class: 'spacer' }),
    h('label', { class: 'field' }, 'Main', mainSelect),
    h('label', { class: 'field' }, 'Compiler', engineSelect),
    h('label', { class: 'toggle', title: 'Pass the draft option to graphicx: images become boxes, which compiles much faster' }, draftBox, 'Fast draft'),
    h('label', { class: 'toggle', title: 'Recompile automatically a moment after you stop typing' }, autoBox, 'Auto compile'),
    compileBtn, scratchBtn, pdfLink, zipLink,
    h('span', { class: 'compiler-info', title: health.description }, health.compiler));

  function update(meta) {
    nameBtn.textContent = meta.name;
    const texFiles = (meta.tree ?? state.tree).filter((e) => e.type === 'file' && e.path.endsWith('.tex')).map((e) => e.path);
    mainSelect.replaceChildren(
      ...(meta.mainFile ? [] : [h('option', { value: '' }, '(choose)')]),
      ...texFiles.map((p) => h('option', { value: p, selected: p === meta.mainFile }, p)));
    mainSelect.value = meta.mainFile ?? '';
    engineSelect.value = meta.engine;
  }

  function setCompiling(on) {
    compileBtn.disabled = on;
    compileBtn.classList.toggle('busy', on);
    compileBtn.querySelector('.compile-label').textContent = on ? 'Compiling…' : 'Recompile';
    scratchBtn.disabled = on;
  }

  update(project);
  return { el, update, setCompiling };
}
