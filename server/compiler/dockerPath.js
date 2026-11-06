import fs from 'node:fs';
import path from 'node:path';

/** Docker Desktop install folders on Windows: per-user first, then machine-wide (the default). */
export function windowsDockerDesktopDirs(env) {
  return [
    ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Programs', 'DockerDesktop')] : []),
    path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker'),
  ];
}

/** Where Docker Desktop puts its CLI, for shells started before Docker was installed. */
export function dockerBinDirs(platform, env) {
  if (platform === 'win32') return windowsDockerDesktopDirs(env).map((d) => path.win32.join(d, 'resources', 'bin'));
  if (platform === 'darwin') return ['/Applications/Docker.app/Contents/Resources/bin', '/usr/local/bin'];
  return [];
}

/**
 * PATH with Docker's install folder appended when it exists but is missing, so a
 * freshly installed Docker is found without opening a new terminal. Returns a new
 * PATH string (or the original if nothing changes).
 */
export function pathWithDocker({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const parts = current.split(sep).filter(Boolean);
  const norm = (p) => (platform === 'win32' ? p.toLowerCase().replace(/\\+$/, '') : p.replace(/\/+$/, ''));
  const missing = dockerBinDirs(platform, env).filter((d) => exists(d) && !parts.some((p) => norm(p) === norm(d)));
  return { key, value: missing.length ? [...parts, ...missing].join(sep) : current };
}

/** Apply pathWithDocker() to this process's environment. */
export function ensureDockerOnPath() {
  const { key, value } = pathWithDocker();
  process.env[key] = value;
}
