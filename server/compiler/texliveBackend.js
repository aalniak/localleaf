import { run } from './exec.js';
import { parseSynctexEdit, parseSynctexView } from './synctex.js';
import { SCRIPT, jobName } from './dockerBackend.js';

const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * Environment for TeX processes running next to the server: keep writes inside
 * the build tree (openout_any=p) and don't hand the password to TeX directly.
 * This is NOT a read sandbox: TeX runs as the server's user, TeX Live 2026 made
 * openin_any a no-op, and a document can still read e.g. /proc/1/environ.
 * Only compile documents you trust (see README, "Security notes").
 */
const TEX_ENV = Object.freeze({
  max_print_line: '10000',
  openout_any: 'p',
  LOCALLEAF_PASSWORD: undefined,
});

/**
 * TeX Live installed alongside Localleaf (e.g. the all-in-one Docker image).
 * Uses the same optimized compile.sh as the Docker backend, run with local bash.
 * Needs bash, rsync and coreutils `timeout` on PATH.
 */
export function createTexliveBackend({ config, projectsDir, runner = run }) {
  const workRoot = toPosix(config.workDir);
  const env = { ...TEX_ENV, LOCALLEAF_DATA_ROOT: projectsDir, LOCALLEAF_WORK_ROOT: config.workDir };
  const srcDir = (id) => `${workRoot}/${id}/src`;
  const pdfOf = (id, meta) => `${workRoot}/${id}/out/${jobName(meta.mainFile)}.pdf`;

  async function compile({ id, meta, draft, fast = true }) {
    const timeout = config.compileTimeoutSec;
    const args = ['-s', 'KILL', String(timeout), 'bash', '-s', '--', id, meta.mainFile, meta.engine, draft ? '1' : '0', fast ? '1' : '0'];
    const result = await runner('timeout', args, { input: SCRIPT, env, timeoutMs: (timeout + 60) * 1000 });
    return { ...result, timedOut: result.timedOut || result.code === 137 || result.code === 124, rootPrefix: srcDir(id) };
  }

  async function synctexView({ id, meta, file, line, column }) {
    const { stdout } = await runner('synctex', ['view', '-i', `${line}:${column}:${srcDir(id)}/${file}`, '-o', pdfOf(id, meta)], { env, timeoutMs: 30000 });
    return parseSynctexView(stdout);
  }

  async function synctexEdit({ id, meta, page, x, y }) {
    const { stdout } = await runner('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfOf(id, meta)}`], { env, timeoutMs: 30000 });
    return parseSynctexEdit(stdout, srcDir(id));
  }

  return {
    name: 'texlive',
    description: 'TeX Live (built-in)',
    supportsSynctex: true,
    supportsEngines: true,
    ensureReady: async () => {},
    compile,
    synctexView,
    synctexEdit,
  };
}
