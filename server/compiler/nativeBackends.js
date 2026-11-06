import path from 'node:path';
import { run, commandExists } from './exec.js';
import { parseSynctexEdit, parseSynctexView } from './synctex.js';
import { jobName } from './dockerBackend.js';
import { unavailable } from '../errors.js';

const ENGINE_FLAGS = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };
const toPosix = (p) => p.replace(/\\/g, '/');

/** latexmk from a local TeX distribution (TeX Live / MiKTeX) on PATH. */
export function createLatexmkBackend({ config, hasSynctex }) {
  async function compile({ meta, draft, filesDir, outputDir }) {
    const args = [
      '-norc', ENGINE_FLAGS[meta.engine] ?? '-pdf', '-f', '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
      `-outdir=${outputDir}`,
      ...(draft ? ['-usepretex=\\PassOptionsToPackage{draft}{graphicx}'] : []),
      meta.mainFile,
    ];
    const timeoutMs = config.compileTimeoutSec * 1000;
    const result = await run('latexmk', args, { cwd: filesDir, env: { max_print_line: '10000', LOCALLEAF_PASSWORD: undefined }, timeoutMs });
    return { ...result, rootPrefix: toPosix(filesDir) };
  }

  async function synctexView({ meta, file, line, column, filesDir, outputDir }) {
    if (!hasSynctex) throw unavailable('The synctex command is not installed');
    const pdf = path.join(outputDir, `${jobName(meta.mainFile)}.pdf`);
    const { stdout } = await run('synctex', ['view', '-i', `${line}:${column}:${path.join(filesDir, file)}`, '-o', pdf]);
    return parseSynctexView(stdout);
  }

  async function synctexEdit({ meta, page, x, y, filesDir, outputDir }) {
    if (!hasSynctex) throw unavailable('The synctex command is not installed');
    const pdf = path.join(outputDir, `${jobName(meta.mainFile)}.pdf`);
    const { stdout } = await run('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdf}`]);
    return parseSynctexEdit(stdout, toPosix(filesDir));
  }

  return {
    name: 'latexmk',
    description: 'Local latexmk installation',
    supportsSynctex: hasSynctex,
    supportsEngines: true,
    ensureReady: async () => {},
    compile,
    synctexView,
    synctexEdit,
  };
}

/** Tectonic: a self-contained XeTeX-based engine that downloads packages on demand. */
export function createTectonicBackend({ config }) {
  async function compile({ meta, filesDir, outputDir }) {
    const args = ['-X', 'compile', '--outdir', outputDir, '--synctex', '--keep-logs', '--keep-intermediates', meta.mainFile];
    const result = await run('tectonic', args, { cwd: filesDir, env: { LOCALLEAF_PASSWORD: undefined }, timeoutMs: config.compileTimeoutSec * 1000 });
    return { ...result, rootPrefix: toPosix(filesDir) };
  }
  const noSync = async () => {
    throw unavailable('SyncTeX lookups are not available with the Tectonic backend');
  };
  return {
    name: 'tectonic',
    description: 'Tectonic (XeTeX engine; the engine setting is ignored)',
    supportsSynctex: false,
    supportsEngines: false,
    ensureReady: async () => {},
    compile,
    synctexView: noSync,
    synctexEdit: noSync,
  };
}

/** Placeholder used when no TeX toolchain is found; explains how to fix it. */
export function createMissingBackend(reason) {
  const fail = async () => {
    throw unavailable(reason);
  };
  return {
    name: 'none',
    description: reason,
    supportsSynctex: false,
    supportsEngines: false,
    ensureReady: async () => {},
    compile: fail,
    synctexView: fail,
    synctexEdit: fail,
  };
}

export { commandExists };
