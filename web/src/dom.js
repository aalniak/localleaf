// Tiny DOM helpers. All text goes through text nodes, never innerHTML, so file
// names and log contents cannot inject markup.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Inline SVG icon from a path list (24x24 viewBox, stroke style). */
export function icon(name) {
  const PATHS = {
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
    plus: 'M12 5v14M5 12h14',
    upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
    download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    play: 'M7 5v14l11-7z',
    home: 'M3 11l9-8 9 8M5 10v10h14V10',
    chevron: 'M9 6l6 6-6 6',
    zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M11 8v6M8 11h6',
    zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M8 11h6',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    right: 'M5 12h14M13 6l6 6-6 6',
    left: 'M19 12H5M11 6l-6 6 6 6',
    folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
    log: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
    pdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.file);
  svg.append(path);
  return svg;
}

let toastHost = null;
export function toast(message, kind = 'info', ms = 4000) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Modal text prompt. Resolves to the trimmed value, or null when cancelled. */
export function askText(title, { value = '', placeholder = '', confirmLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder, class: 'input', 'aria-label': title });
    const dialog = h('dialog', { class: 'modal' },
      h('form', { method: 'dialog' },
        h('h3', {}, title),
        input,
        h('div', { class: 'modal-actions' },
          h('button', { value: 'cancel', class: 'btn', formnovalidate: true }, 'Cancel'),
          h('button', { value: 'ok', class: 'btn btn-primary' }, confirmLabel))));
    dialog.addEventListener('close', () => {
      const result = dialog.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null;
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    input.select();
  });
}

/** Modal confirmation. Resolves to true when confirmed. */
export function askConfirm(title, message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'modal' },
      h('form', { method: 'dialog' },
        h('h3', {}, title),
        h('p', {}, message),
        h('div', { class: 'modal-actions' },
          h('button', { value: 'cancel', class: 'btn' }, 'Cancel'),
          h('button', { value: 'ok', class: 'btn btn-danger' }, confirmLabel))));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'ok');
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`localleaf:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`localleaf:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode); preference is simply not remembered */
    }
  },
};
