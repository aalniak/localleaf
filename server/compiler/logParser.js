/**
 * Parse a TeX log into structured diagnostics.
 *
 * Assumes the log was produced with `-file-line-error` and `max_print_line`
 * raised (no hard wrapping at 79 columns), which both compiler backends set.
 *
 * @typedef {{ level: 'error'|'warning'|'typesetting', message: string,
 *             file: string|null, line: number|null, content: string }} LogEntry
 */

const FILE_LINE_ERROR = /^(.*?\.[A-Za-z0-9]+):(\d+): (.*)$/;
const BANG_ERROR = /^! (.*)$/;
const ERROR_LINE_REF = /^l\.(\d+)/;
const WARNING = /^((?:La|pdf|Xe|Lua)?TeX|LaTeX|Package [\w.-]+|Class [\w.-]+|LaTeX Font) Warning: (.*)$/;
const INPUT_LINE = /on input line (\d+)/;
const BAD_BOX = /^((?:Over|Under)full \\[hv]box .*?)(?: (?:in paragraph|detected|has occurred while \\output is active))? at lines? (\d+)/;
const BAD_BOX_LOOSE = /^((?:Over|Under)full \\[hv]box .*)$/;
const FILE_OPEN = /\((?:"([^"]+)"|([^\s()"]+))/y;

/** Strip a known root prefix and leading "./" so paths match project-relative paths. */
export function normalizeLogPath(file, rootPrefixes = []) {
  if (!file) return null;
  let p = file.replace(/\\/g, '/');
  for (const prefix of rootPrefixes) {
    const pre = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (p.startsWith(pre)) {
      p = p.slice(pre.length);
      break;
    }
  }
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

function looksLikeFile(token) {
  return /^(\.{0,2}\/|[A-Za-z]:\/)/.test(token) || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token);
}

/** Update the open-file stack with the parentheses seen on one log line. */
function trackFiles(line, stack) {
  const next = [...stack];
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '(') {
      FILE_OPEN.lastIndex = i;
      const m = FILE_OPEN.exec(line);
      const token = m ? m[1] ?? m[2] : null;
      if (token && looksLikeFile(token)) {
        next.push(token);
        i += m[0].length - 1;
      } else {
        next.push(null); // non-file parenthesis: keep the stack balanced
      }
    } else if (ch === ')' && next.length > 0) {
      next.pop();
    }
  }
  return next;
}

const currentFile = (stack) => [...stack].reverse().find((f) => f) ?? null;

/** Collect continuation lines of a multi-line warning (indented "(pkg)" lines). */
function collectWarning(lines, start, text) {
  let message = text;
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== '' && /^\s*\([\w.-]+\)\s+/.test(lines[i])) {
    message += ` ${lines[i].replace(/^\s*\([\w.-]+\)\s+/, '')}`;
    i += 1;
  }
  return { message: message.trim(), end: i - 1 };
}

/** Gather the context lines after an error until the "l.NN" reference (max 12 lines). */
function collectErrorContext(lines, start) {
  const content = [];
  let lineNo = null;
  let end = start;
  for (let i = start + 1; i < Math.min(lines.length, start + 13); i += 1) {
    const m = ERROR_LINE_REF.exec(lines[i]);
    content.push(lines[i]);
    if (m) {
      lineNo = Number(m[1]);
      end = i;
      break;
    }
  }
  // `end` covers the echoed source text (which may contain stray parentheses) so the
  // caller can skip it and keep the open-file stack intact.
  return { content: content.join('\n'), lineNo, end };
}

/**
 * @param {string} log
 * @param {{ rootPrefixes?: string[] }} [options]
 * @returns {{ errors: LogEntry[], warnings: LogEntry[], typesetting: LogEntry[], all: LogEntry[] }}
 */
export function parseLatexLog(log, { rootPrefixes = [] } = {}) {
  const lines = String(log ?? '').split(/\r?\n/);
  const all = [];
  const norm = (f) => normalizeLogPath(f, rootPrefixes);
  let stack = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fle = FILE_LINE_ERROR.exec(line);
    if (fle && !line.startsWith('(')) {
      const { content, end } = collectErrorContext(lines, i);
      all.push({ level: 'error', message: fle[3].trim(), file: norm(fle[1]), line: Number(fle[2]), content });
      i = end;
      continue;
    }
    const bang = BANG_ERROR.exec(line);
    if (bang) {
      const { content, lineNo, end } = collectErrorContext(lines, i);
      all.push({ level: 'error', message: bang[1].trim(), file: norm(currentFile(stack)), line: lineNo, content });
      i = end;
      continue;
    }
    const warn = WARNING.exec(line);
    if (warn) {
      const { message, end } = collectWarning(lines, i, warn[2]);
      const ref = INPUT_LINE.exec(message);
      all.push({
        level: 'warning',
        message: `${warn[1]} Warning: ${message}`,
        file: norm(currentFile(stack)),
        line: ref ? Number(ref[1]) : null,
        content: lines.slice(i, end + 1).join('\n'),
      });
      i = end;
      continue;
    }
    const box = BAD_BOX.exec(line) ?? BAD_BOX_LOOSE.exec(line);
    if (box) {
      all.push({
        level: 'typesetting',
        message: box[1],
        file: norm(currentFile(stack)),
        line: box[2] ? Number(box[2]) : null,
        content: line,
      });
      continue;
    }
    stack = trackFiles(line, stack);
  }

  return {
    errors: all.filter((e) => e.level === 'error'),
    warnings: all.filter((e) => e.level === 'warning'),
    typesetting: all.filter((e) => e.level === 'typesetting'),
    all,
  };
}
