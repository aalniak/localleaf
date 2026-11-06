import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.js';
import { unavailable } from '../errors.js';
import { parseSynctexEdit, parseSynctexView } from './synctex.js';

export const SCRIPT = fs
  .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'compile.sh'), 'utf8')
  .replace(/\r\n/g, '\n');

export const jobName = (mainFile) => path.posix.basename(mainFile).replace(/\.[^.]+$/, '');

/**
 * Compiles inside one long-lived TeX Live container (docker exec is much faster
 * than docker run per compile). Project files are bind-mounted at /data.
 * `user` ("uid:gid") runs TeX as the host user so files written into the bind
 * mount are not root-owned on Linux; null keeps the image default (Windows).
 */
export function createDockerBackend({ config, projectsDir, runner = run, user = null }) {
  const name = config.containerName;
  const docker = (args, opts) => runner('docker', args, opts);
  let ready = null;

  async function startContainer() {
    const inspect = await docker(['inspect', '-f', '{{.State.Running}}|{{index .Config.Labels "localleaf.data"}}|{{index .Config.Labels "localleaf.user"}}', name]);
    if (inspect.code === 0) {
      const [running, label, userLabel = ''] = inspect.stdout.trim().split('|');
      const same = label === projectsDir && userLabel === (user ?? '');
      if (same && running === 'true') return;
      if (same) {
        const started = await docker(['start', name]);
        if (started.code === 0) return;
      }
      await docker(['rm', '-f', name]);
    }
    const created = await docker([
      'run', '-d', '--name', name,
      '--label', `localleaf.data=${projectsDir}`,
      ...(user ? ['--label', `localleaf.user=${user}`, '--user', user, '-e', 'HOME=/tmp'] : []),
      '-v', `${projectsDir}:/data`,
      '--entrypoint', 'sleep',
      config.dockerImage, 'infinity',
    ]);
    if (created.code !== 0) {
      throw unavailable(`Could not start the TeX Live container: ${created.stderr.trim() || created.stdout.trim()}`);
    }
    if (user) {
      const prepared = await docker(['exec', '-u', '0', name, 'mkdir', '-p', '-m', '1777', '/work']);
      if (prepared.code !== 0) {
        throw unavailable(`Could not prepare /work in the TeX Live container: ${prepared.stderr.trim() || prepared.stdout.trim()}`);
      }
    }
  }

  function ensureReady() {
    if (!ready) {
      ready = startContainer().catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  }

  /** Re-check the container before each use: it may have been stopped externally. */
  async function withContainer(fn) {
    await ensureReady();
    const result = await fn();
    if (result.code !== 0 && /No such container|is not running/i.test(result.stderr)) {
      ready = null;
      await ensureReady();
      return fn();
    }
    return result;
  }

  async function compile({ id, meta, draft, fast = true }) {
    const timeout = config.compileTimeoutSec;
    const args = [
      'exec', '-i', '-e', 'max_print_line=10000', name,
      'timeout', '-s', 'KILL', String(timeout),
      'bash', '-s', '--', id, meta.mainFile, meta.engine, draft ? '1' : '0', fast ? '1' : '0',
    ];
    const result = await withContainer(() => docker(args, { input: SCRIPT, timeoutMs: (timeout + 60) * 1000 }));
    return { ...result, timedOut: result.timedOut || result.code === 137 || result.code === 124, rootPrefix: `/work/${id}/src` };
  }

  async function synctexView({ id, meta, file, line, column }) {
    const out = `/work/${id}/out/${jobName(meta.mainFile)}.pdf`;
    const input = `${line}:${column}:/work/${id}/src/${file}`;
    const result = await withContainer(() => docker(['exec', name, 'synctex', 'view', '-i', input, '-o', out], { timeoutMs: 30000 }));
    return parseSynctexView(result.stdout);
  }

  async function synctexEdit({ id, meta, page, x, y }) {
    const out = `/work/${id}/out/${jobName(meta.mainFile)}.pdf`;
    const result = await withContainer(() => docker(['exec', name, 'synctex', 'edit', '-o', `${page}:${x}:${y}:${out}`], { timeoutMs: 30000 }));
    return parseSynctexEdit(result.stdout, `/work/${id}/src`);
  }

  return {
    name: 'docker',
    description: `TeX Live in Docker (${config.dockerImage})`,
    supportsSynctex: true,
    supportsEngines: true,
    ensureReady,
    compile,
    synctexView,
    synctexEdit,
  };
}
