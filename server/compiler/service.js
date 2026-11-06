import fs from 'node:fs/promises';
import path from 'node:path';
import { parseLatexLog } from './logParser.js';
import { jobName } from './dockerBackend.js';
import { badRequest, conflict } from '../errors.js';
import { normalizeRelPath, isSafeMainFile } from '../paths.js';

const MAX_LOG_CHARS = 3 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20000;

const tail = (s, n) => (s.length > n ? s.slice(-n) : s);

/** Orchestrates compiles (one at a time per project) and SyncTeX lookups. */
export class CompileService {
  constructor({ store, backend }) {
    this.store = store;
    this.backend = backend;
    this.running = new Map();
  }

  isRunning(id) {
    return this.running.has(id);
  }

  async compile(id, { draft = false } = {}) {
    if (this.running.has(id)) throw conflict('A compile is already running for this project');
    const job = this.#compile(id, { draft: Boolean(draft) });
    this.running.set(id, job);
    try {
      return await job;
    } finally {
      this.running.delete(id);
    }
  }

  async #compile(id, { draft }) {
    const meta = await this.store.get(id);
    if (!meta.mainFile) throw badRequest('Choose a main document before compiling');
    if (!isSafeMainFile(meta.mainFile)) throw badRequest('The main document name contains characters LaTeX cannot compile');
    await this.store.rawPath(id, meta.mainFile);
    const outputDir = this.store.outputDir(id);
    const job = jobName(meta.mainFile);
    await fs.mkdir(outputDir, { recursive: true });
    await Promise.all(
      ['pdf', 'log', 'synctex.gz', 'blg'].map((ext) => fs.rm(path.join(outputDir, `${job}.${ext}`), { force: true })),
    );

    const started = Date.now();
    const result = await this.backend.compile({ id, meta, draft, filesDir: this.store.filesDir(id), outputDir });
    const durationMs = Date.now() - started;
    const summary = await this.#summarize(id, meta, result.rootPrefix);
    // A non-zero exit with no log means the toolchain itself failed (sync error, docker error, …).
    const crashed = summary.status === 'none' && result.code !== 0;
    const status = result.timedOut ? 'timeout' : crashed ? 'failure' : summary.status;
    return {
      ...summary,
      status,
      durationMs,
      draft,
      output: tail(`${result.stdout}\n${result.stderr}`.trim(), MAX_OUTPUT_CHARS),
    };
  }

  /** Describe the latest output on disk (used when a project is opened). */
  async lastOutput(id) {
    const meta = await this.store.get(id);
    if (!meta.mainFile) return { status: 'none', pdf: null, errors: [], warnings: [], typesetting: [], log: '' };
    const rootPrefix = this.backend.name === 'docker' ? `/work/${id}/src` : this.store.filesDir(id).replace(/\\/g, '/');
    return this.#summarize(id, meta, rootPrefix);
  }

  async #summarize(id, meta, rootPrefix) {
    const outputDir = this.store.outputDir(id);
    const job = jobName(meta.mainFile);
    const log = await fs.readFile(path.join(outputDir, `${job}.log`), 'utf8').catch(() => '');
    const pdfStat = await fs.stat(path.join(outputDir, `${job}.pdf`)).catch(() => null);
    const parsed = parseLatexLog(log, { rootPrefixes: [rootPrefix] });
    let status = 'success';
    if (!pdfStat) status = log ? 'failure' : 'none';
    else if (parsed.errors.length > 0) status = 'error';
    return {
      status,
      pdf: pdfStat ? { url: `/api/projects/${id}/output/pdf?v=${Math.round(pdfStat.mtimeMs)}`, size: pdfStat.size } : null,
      errors: parsed.errors,
      warnings: parsed.warnings,
      typesetting: parsed.typesetting,
      log: tail(log, MAX_LOG_CHARS),
    };
  }

  async pdfPath(id) {
    const meta = await this.store.get(id);
    if (!meta.mainFile) return null;
    const file = path.join(this.store.outputDir(id), `${jobName(meta.mainFile)}.pdf`);
    return (await fs.stat(file).catch(() => null)) ? file : null;
  }

  async syncFromSource(id, { file, line, column = 0 }) {
    const meta = await this.store.get(id);
    const rel = normalizeRelPath(file);
    const ln = toPositiveInt(line, 'line');
    const col = Math.max(0, Number.parseInt(column, 10) || 0);
    return this.backend.synctexView({ id, meta, file: rel, line: ln, column: col, ...this.#dirs(id) });
  }

  async syncFromPdf(id, { page, x, y }) {
    const meta = await this.store.get(id);
    const pg = toPositiveInt(page, 'page');
    const px = toFiniteNumber(x, 'x');
    const py = toFiniteNumber(y, 'y');
    return this.backend.synctexEdit({ id, meta, page: pg, x: px, y: py, ...this.#dirs(id) });
  }

  #dirs(id) {
    return { filesDir: this.store.filesDir(id), outputDir: this.store.outputDir(id) };
  }
}

function toPositiveInt(value, name) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) throw badRequest(`"${name}" must be a positive integer`);
  return n;
}

function toFiniteNumber(value, name) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`"${name}" must be a non-negative number`);
  return Math.round(n * 100) / 100;
}
