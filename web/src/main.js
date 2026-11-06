import './styles.css';
import { openProjectList } from './projectList.js';
import { openWorkspace } from './editor/workspace.js';
import { h } from './dom.js';

const root = document.getElementById('app');
let teardown = null;

/** Hash router: #/ → project list, #/project/<id> → editor. */
async function route() {
  teardown?.();
  teardown = null;
  const match = location.hash.match(/^#\/project\/([a-f0-9]{16})$/);
  try {
    teardown = match ? await openWorkspace(root, match[1]) : await openProjectList(root);
  } catch (err) {
    root.replaceChildren(h('div', { class: 'fatal' },
      h('h2', {}, 'Something went wrong'),
      h('p', {}, err.message),
      h('a', { href: '#/' }, 'Back to projects')));
  }
}

window.addEventListener('hashchange', route);
route();
