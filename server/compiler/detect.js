import path from 'node:path';
import { createDockerBackend } from './dockerBackend.js';
import { createTexliveBackend } from './texliveBackend.js';
import { createLatexmkBackend, createTectonicBackend, createMissingBackend, commandExists } from './nativeBackends.js';

const MISSING =
  'No LaTeX compiler found. Start Docker Desktop (recommended: full TeX Live via the texlive/texlive image), ' +
  'or install TeX Live / MiKTeX (latexmk) or Tectonic and restart Localleaf.';

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
