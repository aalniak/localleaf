import path from 'node:path';
import { createDockerBackend } from './dockerBackend.js';
import { createTexliveBackend } from './texliveBackend.js';
import { createLatexmkBackend, createTectonicBackend, createMissingBackend, commandExists } from './nativeBackends.js';

const MISSING =
  'No LaTeX compiler found. Run "npm run setup" in the Localleaf folder to install or start Docker (recommended), ' +
  'or install TeX Live / MiKTeX (latexmk) or Tectonic. Localleaf picks it up automatically, without a restart.';

/** "uid:gid" of this process on POSIX (so container output is not root-owned); null on Windows. */
export function hostUser(proc = process) {
  return typeof proc.getuid === 'function' ? `${proc.getuid()}:${proc.getgid()}` : null;
}

/** Pick a compiler backend according to config.compiler ("auto" probes docker → latexmk → tectonic). */
export async function detectBackend(config, { exists = commandExists } = {}) {
  const projectsDir = path.join(config.dataDir, 'projects');
  const docker = () => createDockerBackend({ config, projectsDir, user: hostUser() });
  const latexmk = async () => createLatexmkBackend({ config, hasSynctex: await exists('synctex', ['help']) });
  const tectonic = () => createTectonicBackend({ config });

  switch (config.compiler) {
    case 'docker':
      return docker();
    case 'texlive':
      return createTexliveBackend({ config, projectsDir });
    case 'latexmk':
      return latexmk();
    case 'tectonic':
      return tectonic();
    default:
      if (await exists('docker', ['info', '--format', '{{.ServerVersion}}'])) return docker();
      if (await exists('latexmk', ['-v'])) return latexmk();
      if (await exists('tectonic', ['--version'])) return tectonic();
      return createMissingBackend(MISSING);
  }
}

/**
 * Wraps the start-up backend so that, while no compiler is available, it re-runs
 * detection (at most every `intervalMs`) on compile/health. Installing or starting
 * Docker or TeX later then works without restarting Localleaf.
 */
export function createRedetectingBackend(initial, redetect, { now = Date.now, intervalMs = 5000 } = {}) {
  let current = initial;
  let checkedAt = now();
  let pending = null;

  async function refresh() {
    if (current.name !== 'none' || now() - checkedAt < intervalMs) return current;
    pending ??= (async () => {
      try {
        const next = await redetect();
        if (next.name !== 'none') {
          current = next;
          console.log(`[localleaf] compiler found: ${next.description}`);
          // Don't wait: preparing Docker can mean pulling a ~5 GB image. Compiles call it again lazily.
          Promise.resolve(next.ensureReady?.()).then(
            () => console.log('[localleaf] compiler ready'),
            (err) => console.error(`[localleaf] compiler not ready yet: ${err.message}`),
          );
        }
      } catch (err) {
        console.error(`[localleaf] compiler not ready yet: ${err.message}`);
      } finally {
        checkedAt = now();
        pending = null;
      }
    })();
    await pending;
    return current;
  }

  const delegate = (method) => async (args) => (await refresh())[method](args);
  return {
    get name() { return current.name; },
    get description() { return current.description; },
    get supportsSynctex() { return current.supportsSynctex; },
    get supportsEngines() { return current.supportsEngines; },
    refresh,
    ensureReady: async () => (await refresh()).ensureReady?.(),
    compile: delegate('compile'),
    synctexView: delegate('synctexView'),
    synctexEdit: delegate('synctexEdit'),
  };
}
