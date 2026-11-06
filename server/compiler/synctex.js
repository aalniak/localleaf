import { normalizeLogPath } from './logParser.js';

/** Parse "Key:value" records from `synctex view` / `synctex edit` output. */
function parseRecords(stdout) {
  const body = String(stdout).split('SyncTeX result begin')[1]?.split('SyncTeX result end')[0] ?? '';
  const records = [];
  let current = null;
  for (const raw of body.split(/\r?\n/)) {
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    if (key === 'Output') {
      current = {};
      records.push(current);
    } else if (current) {
      current[key] = value;
    }
  }
  return records;
}

/**
 * Positions in the PDF for a source location. Coordinates are PDF points from the
 * top-left of the page.
 * @returns {{ page: number, h: number, v: number, width: number, height: number }[]}
 */
export function parseSynctexView(stdout) {
  return parseRecords(stdout)
    .filter((r) => r.Page)
    .map((r) => ({
      page: Number(r.Page),
      h: Number(r.h),
      v: Number(r.v),
      width: Number(r.W),
      height: Number(r.H),
    }))
    .filter((r) => Number.isFinite(r.page) && Number.isFinite(r.h) && Number.isFinite(r.v));
}

/**
 * The source location for a PDF position, or null when it is outside the project
 * (for example inside a generated .toc or a TeX Live package).
 * @returns {{ file: string, line: number, column: number } | null}
 */
export function parseSynctexEdit(stdout, rootPrefix) {
  const rec = parseRecords(stdout).find((r) => r.Input && r.Line);
  if (!rec) return null;
  const input = rec.Input.replace(/\\/g, '/').replace(/\/\.\//g, '/');
  const prefix = rootPrefix.replace(/\\/g, '/').replace(/\/?$/, '/');
  if (!input.startsWith(prefix)) return null;
  const line = Number(rec.Line);
  if (!Number.isFinite(line) || line < 1) return null;
  return { file: normalizeLogPath(input, [prefix]), line, column: Math.max(0, Number(rec.Column) || 0) };
}
