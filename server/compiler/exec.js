import { spawn } from 'node:child_process';

/** process.env plus overrides; an override of `undefined` removes the variable. */
function mergeEnv(overrides) {
  if (!overrides) return process.env;
  return Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([, v]) => v !== undefined));
}

/**
 * Run a command without a shell. Never rejects for non-zero exit codes; only for
 * spawn failures (e.g. binary not found), which carry `code === 'ENOENT'`.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function run(cmd, args, { cwd, env, input, timeoutMs = 0, maxOutput = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: mergeEnv(env), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (buf, chunk) => (buf.length < maxOutput ? buf + chunk.toString() : buf);
    child.stdout.on('data', (c) => { stdout = append(stdout, c); });
    child.stderr.on('data', (c) => { stderr = append(stderr, c); });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Whether a command can be executed (spawn succeeds). */
export async function commandExists(cmd, args = ['--version']) {
  try {
    const { code } = await run(cmd, args, { timeoutMs: 15000 });
    return code === 0;
  } catch {
    return false;
  }
}
