import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInside, normalizeRelPath, isTextFile, isSafeMainFile } from '../paths.js';
import { badRequest, notFound, conflict } from '../errors.js';
import { BLANK_MAIN_TEX } from './templates.js';
import { detectMainFile } from './zipImport.js';

export const ENGINES = ['pdflatex', 'xelatex', 'lualatex'];
const ID_PATTERN = /^[a-f0-9]{16}$/;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;

/**
 * @typedef {{ id: string, name: string, mainFile: string|null, engine: string,
 *             createdAt: string, updatedAt: string }} ProjectMeta
 * @typedef {{ path: string, type: 'file'|'dir', size?: number }} TreeEntry
 */

const exists = (p) => fs.stat(p).then(() => true, () => false);

function cleanName(name) {
  if (typeof name !== 'string') throw badRequest('Project name must be a string');
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw badRequest('Project name cannot be empty');
  if (trimmed.length > 200) throw badRequest('Project name is too long');
  return trimmed;
}

/** Filesystem-backed repository of LaTeX projects: <dataDir>/projects/<id>/{project.json,files/,output/}. */
export class ProjectStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'projects');
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }

  projectDir(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw notFound('Project not found');
    return path.join(this.root, id);
  }

  filesDir(id) {
    return path.join(this.projectDir(id), 'files');
  }

  outputDir(id) {
    return path.join(this.projectDir(id), 'output');
  }

  /** @returns {Promise<ProjectMeta[]>} newest first */
  async list() {
    const names = await fs.readdir(this.root).catch(() => []);
    const metas = await Promise.all(
      names.filter((n) => ID_PATTERN.test(n)).map((id) => this.get(id).catch(() => null)),
    );
    return metas.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** @returns {Promise<ProjectMeta>} */
  async get(id) {
    const file = path.join(this.projectDir(id), 'project.json');
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound('Project not found');
      throw err;
    }
  }

  /**
   * Create a project from { path, data } entries (a blank template when none are given).
   * @returns {Promise<ProjectMeta>}
   */
  async create({ name, entries, engine = 'pdflatex' }) {
    const files = entries?.length ? entries : [{ path: 'main.tex', data: Buffer.from(BLANK_MAIN_TEX) }];
    assertNoCollisions(files);
    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const detected = detectMainFile(files);
    const meta = {
      id,
      name: cleanName(name),
      mainFile: detected && isSafeMainFile(detected) ? detected : null,
      engine: ENGINES.includes(engine) ? engine : 'pdflatex',
      createdAt: now,
      updatedAt: now,
    };
    const filesDir = this.filesDir(id);
    try {
      await fs.mkdir(filesDir, { recursive: true });
      await fs.mkdir(this.outputDir(id), { recursive: true });
      for (const entry of files) {
        const target = resolveInside(filesDir, entry.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, entry.data);
      }
      await this.#writeMeta(meta);
    } catch (err) {
      await fs.rm(this.projectDir(id), { recursive: true, force: true });
      throw err;
    }
    return meta;
  }

  /** @returns {Promise<ProjectMeta>} a new meta object with the patch applied */
  async update(id, patch) {
    return this.#mutateMeta(id, async (current) => {
      const next = { ...current, updatedAt: new Date().toISOString() };
      if (patch.name !== undefined) next.name = cleanName(patch.name);
      if (patch.engine !== undefined) {
        if (!ENGINES.includes(patch.engine)) throw badRequest(`Engine must be one of ${ENGINES.join(', ')}`);
        next.engine = patch.engine;
      }
      if (patch.mainFile !== undefined) {
        const rel = normalizeRelPath(patch.mainFile);
        if (!rel.toLowerCase().endsWith('.tex')) throw badRequest('Main document must be a .tex file');
        if (!isSafeMainFile(rel)) throw badRequest('Main document names cannot start with "-" or contain { } \\ % # $ ^ ~ &');
        const stat = await fs.stat(resolveInside(this.filesDir(id), rel)).catch(() => null);
        if (!stat?.isFile()) throw badRequest(`Main document "${rel}" does not exist`);
        next.mainFile = rel;
      }
      return next;
    });
  }

  async touch(id) {
    await this.#mutateMeta(id, (meta) => ({ ...meta, updatedAt: new Date().toISOString() }));
  }

  async remove(id) {
    await this.get(id);
    await fs.rm(this.projectDir(id), { recursive: true, force: true });
  }

  /** @returns {Promise<TreeEntry[]>} every file and folder, sorted by path */
  async tree(id) {
    await this.get(id);
    const base = this.filesDir(id);
    const out = [];
    const walk = async (dir, prefix) => {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          out.push({ path: rel, type: 'dir' });
          await walk(path.join(dir, item.name), rel);
        } else if (item.isFile()) {
          const { size } = await fs.stat(path.join(dir, item.name));
          out.push({ path: rel, type: 'file', size });
        }
      }
    };
    await walk(base, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** @returns {Promise<{ path: string, editable: boolean, content?: string, size: number }>} */
  async readFile(id, relPath) {
    const full = await this.#existingFile(id, relPath);
    const data = await fs.readFile(full);
    const rel = normalizeRelPath(relPath);
    if (!isTextFile(rel, data) || data.length > MAX_TEXT_BYTES) {
      return { path: rel, editable: false, size: data.length };
    }
    return { path: rel, editable: true, content: data.toString('utf8'), size: data.length };
  }

  /** Absolute path of an existing file, for streaming raw bytes. */
  async rawPath(id, relPath) {
    return this.#existingFile(id, relPath);
  }

  async writeFile(id, relPath, data) {
    await this.get(id);
    const full = resolveInside(this.filesDir(id), relPath);
    const stat = await fs.stat(full).catch(() => null);
    if (stat?.isDirectory()) throw conflict(`"${relPath}" is a folder`);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    await this.touch(id);
    return normalizeRelPath(relPath);
  }

  async createFolder(id, relPath) {
    await this.get(id);
    const full = resolveInside(this.filesDir(id), relPath);
    if (await exists(full)) throw conflict(`"${relPath}" already exists`);
    await fs.mkdir(full, { recursive: true });
    return normalizeRelPath(relPath);
  }

  async move(id, from, to) {
    const base = this.filesDir(id);
    const fromRel = normalizeRelPath(from);
    const toRel = normalizeRelPath(to);
    const src = resolveInside(base, fromRel);
    const dst = resolveInside(base, toRel);
    if (toRel.startsWith(`${fromRel}/`)) throw badRequest('Cannot move a folder into itself');
    // A case-only rename (a.tex → A.tex) "exists" on case-insensitive filesystems; allow it.
    const caseOnly = fromRel !== toRel && fromRel.toLowerCase() === toRel.toLowerCase();
    await this.#mutateMeta(id, async (meta) => {
      if (!(await exists(src))) throw notFound(`"${from}" does not exist`);
      if (!caseOnly && (await exists(dst))) throw conflict(`"${to}" already exists`);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      const mainFile = remapPath(meta.mainFile, fromRel, toRel);
      return { ...meta, mainFile: mainFile && isSafeMainFile(mainFile) ? mainFile : null, updatedAt: new Date().toISOString() };
    });
    return toRel;
  }

  async deleteEntry(id, relPath) {
    const rel = normalizeRelPath(relPath);
    const full = resolveInside(this.filesDir(id), rel);
    await this.#mutateMeta(id, async (meta) => {
      if (!(await exists(full))) throw notFound(`"${relPath}" does not exist`);
      await fs.rm(full, { recursive: true, force: true });
      const mainGone = meta.mainFile === rel || meta.mainFile?.startsWith(`${rel}/`);
      return { ...meta, mainFile: mainGone ? null : meta.mainFile, updatedAt: new Date().toISOString() };
    });
  }

  /** @returns {Promise<{ path: string, data: Buffer }[]>} */
  async exportEntries(id) {
    const base = this.filesDir(id);
    const files = (await this.tree(id)).filter((e) => e.type === 'file');
    return Promise.all(files.map(async (f) => ({ path: f.path, data: await fs.readFile(resolveInside(base, f.path)) })));
  }

  async clearOutput(id) {
    await this.get(id);
    await fs.rm(this.outputDir(id), { recursive: true, force: true });
    await fs.mkdir(this.outputDir(id), { recursive: true });
  }

  async #existingFile(id, relPath) {
    await this.get(id);
    const full = resolveInside(this.filesDir(id), relPath);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) throw notFound(`File "${relPath}" not found`);
    return full;
  }

  /** Serialize read-modify-write cycles of one project's metadata (no lost updates). */
  #locks = new Map();

  async #mutateMeta(id, fn) {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const task = previous.then(async () => {
      const next = await fn(await this.get(id));
      await this.#writeMeta(next);
      return next;
    });
    const tail = task.catch(() => {});
    this.#locks.set(id, tail);
    try {
      return await task;
    } finally {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    }
  }

  async #writeMeta(meta) {
    const file = path.join(this.projectDir(meta.id), 'project.json');
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fs.rename(tmp, file);
  }
}

/** Reject archives whose paths collide on case-insensitive filesystems or as file-vs-folder. */
function assertNoCollisions(entries) {
  const seen = new Map();
  for (const { path: p } of entries) {
    const key = p.toLowerCase();
    if (seen.has(key)) throw badRequest(`"${seen.get(key)}" and "${p}" would overwrite each other on this filesystem`);
    seen.set(key, p);
  }
  for (const { path: p } of entries) {
    const parts = p.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (seen.has(dir)) throw badRequest(`"${seen.get(dir)}" is both a file and a folder in this archive`);
    }
  }
}

/** Rewrite a path after its file or an ancestor folder was renamed. */
export function remapPath(p, from, to) {
  if (!p) return p;
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p;
}
