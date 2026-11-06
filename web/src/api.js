// Thin client for the Localleaf REST API. Every call resolves to `data` from the
// { success, data, error } envelope or throws an Error with a readable message.

const enc = encodeURIComponent;

async function request(method, url, body) {
  const init = { method, headers: { 'X-Localleaf': '1' } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
    // keepalive lets a save started during page unload finish (browsers cap it at 64 KB).
    if (init.body.length < 60000) init.keepalive = true;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Cannot reach the Localleaf server. Is it still running?');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const err = new Error(json?.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

const p = (id) => `/api/projects/${enc(id)}`;

export const api = {
  health: () => request('GET', '/api/health'),

  listProjects: () => request('GET', '/api/projects'),
  createProject: (name) => request('POST', '/api/projects', { name }),
  importZip: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('POST', '/api/projects/import', form);
  },
  getProject: (id) => request('GET', p(id)),
  updateProject: (id, patch) => request('PATCH', p(id), patch),
  deleteProject: (id) => request('DELETE', p(id)),
  downloadUrl: (id) => `${p(id)}/download`,

  readFile: (id, path) => request('GET', `${p(id)}/file?path=${enc(path)}`),
  rawUrl: (id, path) => `${p(id)}/raw?path=${enc(path)}`,
  writeFile: (id, path, content) => request('PUT', `${p(id)}/file`, { path, content }),
  createFolder: (id, path) => request('POST', `${p(id)}/folder`, { path }),
  upload: (id, files, dir = '') => {
    const form = new FormData();
    form.append('dir', dir);
    for (const f of files) form.append('files', f, f.name);
    return request('POST', `${p(id)}/upload`, form);
  },
  move: (id, from, to) => request('POST', `${p(id)}/move`, { from, to }),
  deleteEntry: (id, path) => request('DELETE', `${p(id)}/file?path=${enc(path)}`),

  compile: (id, { draft = false } = {}) => request('POST', `${p(id)}/compile`, { draft }),
  lastCompile: (id) => request('GET', `${p(id)}/compile/last`),
  clearCache: (id) => request('POST', `${p(id)}/clear-cache`),
  syncView: (id, file, line, column = 0) =>
    request('GET', `${p(id)}/synctex/view?file=${enc(file)}&line=${line}&column=${column}`),
  syncEdit: (id, page, x, y) => request('GET', `${p(id)}/synctex/edit?page=${page}&x=${x}&y=${y}`),
};
