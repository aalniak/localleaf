import AdmZip from 'adm-zip';
import { normalizeRelPath } from '../paths.js';
import { badRequest } from '../errors.js';

const IGNORED = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/];
const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // guard against zip bombs

/** Read a zip buffer into a list of { path, data } file entries (directories omitted). */
export function readZipEntries(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw badRequest(`Not a valid zip archive: ${err.message}`);
  }
  const raw = zip.getEntries().filter((e) => !e.isDirectory);
  if (raw.length > MAX_ENTRIES) throw badRequest(`Zip has too many files (${raw.length} > ${MAX_ENTRIES})`);

  let total = 0;
  const entries = [];
  for (const entry of raw) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (IGNORED.some((re) => re.test(name))) continue;
    total += entry.header.size;
    if (total > MAX_TOTAL_BYTES) throw badRequest('Zip expands to more than 1 GB');
    entries.push({ path: normalizeRelPath(name), data: entry.getData() });
  }
  if (entries.length === 0) throw badRequest('Zip archive contains no files');
  return stripCommonRoot(entries);
}

/** If every file sits under the same single top-level folder, drop that folder. */
export function stripCommonRoot(entries) {
  const firstSegments = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : null)));
  if (firstSegments.size !== 1 || firstSegments.has(null)) return entries;
  const [root] = firstSegments;
  return entries.map((e) => ({ ...e, path: e.path.slice(root.length + 1) }));
}

const DOCUMENTCLASS = /^[^%\n]*\\documentclass/m;

/**
 * Choose the root document the way Overleaf does: main.tex if present,
 * otherwise the shallowest .tex file that declares \documentclass.
 */
export function detectMainFile(entries) {
  const texFiles = entries.filter((e) => e.path.toLowerCase().endsWith('.tex'));
  if (texFiles.length === 0) return null;
  const main = texFiles.find((e) => e.path === 'main.tex');
  if (main) return main.path;
  const withClass = texFiles
    .filter((e) => DOCUMENTCLASS.test(e.data.toString('utf8')))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return (withClass[0] ?? texFiles[0]).path;
}

/** Build a zip archive buffer from { path, data } entries. */
export function buildZip(entries) {
  const zip = new AdmZip();
  for (const { path, data } of entries) zip.addFile(path, data);
  return zip.toBuffer();
}
