import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMPILER_MODES = ['auto', 'docker', 'texlive', 'latexmk', 'tectonic'];

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** One host entry as it appears in a Host header, without port: "a.lan:80" -> "a.lan", "fd00::1" -> "[fd00::1]". */
function normalizeHost(entry) {
  const h = entry.trim().toLowerCase();
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(h);
  if (bracketed) return bracketed[1];
  if ((h.match(/:/g) ?? []).length > 1) return `[${h}]`; // bare IPv6 literal
  return h.replace(/:\d+$/, '');
}

/** "a.lan, B.lan:80," -> ["a.lan", "b.lan"] (ports are ignored when matching). */
function hostList(value) {
  return (value ?? '').split(',').filter((h) => h.trim()).map(normalizeHost);
}

/** Express "trust proxy" value: unset/false -> false, "true" -> true, "2" -> 2, else a subnet list like "loopback". */
function trustProxy(value) {
  const v = (value ?? '').trim().toLowerCase();
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}

/** Build an immutable configuration object from environment variables. */
export function loadConfig(env = process.env) {
  const compiler = (env.LOCALLEAF_COMPILER || 'auto').toLowerCase();
  if (!COMPILER_MODES.includes(compiler)) {
    throw new Error(`LOCALLEAF_COMPILER must be one of ${COMPILER_MODES.join(', ')} (got "${compiler}")`);
  }
  return Object.freeze({
    host: env.LOCALLEAF_HOST || '127.0.0.1',
    port: positiveInt(env.PORT, 4000),
    allowedHosts: Object.freeze(hostList(env.LOCALLEAF_ALLOWED_HOSTS)),
    password: (env.LOCALLEAF_PASSWORD ?? '').trim(),
    trustProxy: trustProxy(env.LOCALLEAF_TRUST_PROXY),
    dataDir: path.resolve(env.LOCALLEAF_DATA_DIR || path.join(ROOT_DIR, 'data')),
    workDir: path.resolve(env.LOCALLEAF_WORK_DIR || path.join(os.tmpdir(), 'localleaf-work')),
    compiler,
    dockerImage: env.LOCALLEAF_DOCKER_IMAGE || 'texlive/texlive:latest',
    containerName: env.LOCALLEAF_CONTAINER || 'localleaf-texlive',
    compileTimeoutSec: positiveInt(env.LOCALLEAF_COMPILE_TIMEOUT, 300),
    maxUploadMb: positiveInt(env.LOCALLEAF_MAX_UPLOAD_MB, 300),
    webDist: path.join(ROOT_DIR, 'web', 'dist'),
  });
}
