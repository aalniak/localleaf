import { api } from '../api.js';

const SAVE_DELAY_MS = 700;

/**
 * Debounced, ordered autosave. Changes are queued per path; flush() writes
 * everything pending (sequentially, so saves never race) and resolves to true
 * when all writes succeeded.
 */
export class DocumentSaver {
  constructor(projectId, { onState }) {
    this.projectId = projectId;
    this.onState = onState;
    this.pending = new Map();
    this.saved = new Map();
    this.dropped = new Set();
    this.timer = null;
    this.chain = Promise.resolve(true);
  }

  markSaved(path, content) {
    this.saved.set(path, content);
  }

  queue(path, content) {
    this.dropped.delete(path);
    this.pending.set(path, content);
    this.onState('unsaved');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  hasPending() {
    return this.pending.size > 0;
  }

  flush() {
    clearTimeout(this.timer);
    const batch = [...this.pending];
    this.pending.clear();
    this.chain = this.chain.then(() => this.#write(batch));
    return this.chain;
  }

  #isDropped(path) {
    return [...this.dropped].some((d) => path === d || path.startsWith(`${d}/`));
  }

  async #write(batch) {
    const changed = batch.filter(([path, content]) => this.saved.get(path) !== content && !this.#isDropped(path));
    if (!changed.length) {
      if (!this.pending.size) this.onState('saved');
      return true;
    }
    this.onState('saving');
    let okAll = true;
    for (const [path, content] of changed) {
      try {
        await api.writeFile(this.projectId, path, content);
        this.saved.set(path, content);
      } catch (err) {
        okAll = false;
        if (!this.pending.has(path)) this.pending.set(path, content); // retry on next flush
        this.onState('error', `Could not save ${path}: ${err.message}`);
      }
    }
    if (okAll) this.onState(this.pending.size ? 'unsaved' : 'saved');
    return okAll;
  }

  rename(from, to) {
    for (const map of [this.pending, this.saved]) {
      for (const key of [...map.keys()]) {
        if (key === from || key.startsWith(`${from}/`)) {
          map.set(to + key.slice(from.length), map.get(key));
          map.delete(key);
        }
      }
    }
  }

  /** Drop a deleted path (or folder): queued or in-flight batches will not recreate it. */
  forget(path) {
    this.dropped.add(path);
    for (const map of [this.pending, this.saved]) {
      for (const key of [...map.keys()]) if (key === path || key.startsWith(`${path}/`)) map.delete(key);
    }
  }
}
