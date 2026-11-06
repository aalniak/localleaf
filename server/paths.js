import path from 'node:path';
import { badRequest } from './errors.js';

// Characters Windows refuses in file names; rejecting them everywhere keeps projects portable.
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;
// Windows device names (NUL.tex, con, COM1.txt …) silently swallow writes on NTFS.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// Characters that would let a main-file name be read as a command-line option or as TeX code.
const UNSAFE_MAIN_CHARS = /[{}\\%#$^~&]/;

/** Whether a (normalized) path is safe to hand to latexmk/pdflatex as the root document. */
export function isSafeMainFile(relPath) {
  return typeof relPath === 'string' && !relPath.startsWith('-') && !UNSAFE_MAIN_CHARS.test(relPath);
}

/**
 * Normalize a user-supplied project-relative path to a POSIX path with no
 * leading slash, rejecting anything that could escape the project root.
 */
export function normalizeRelPath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw badRequest('A path is required');
  const unified = input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(unified)) throw badRequest(`Path "${input}" must be relative`);
  const normalized = path.posix.normalize(unified);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw badRequest(`Path "${input}" points outside the project`);
  }
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw badRequest(`Invalid path "${input}"`);
    if (FORBIDDEN_CHARS.test(segment)) throw badRequest(`Path "${input}" contains invalid characters`);
    if (RESERVED_NAMES.test(segment) || /[. ]$/.test(segment)) throw badRequest(`"${segment}" is not a valid file name`);
    if (segment.length > 255) throw badRequest('Path segment too long');
  }
  return normalized;
}

/** Resolve a project-relative path to an absolute path guaranteed to stay inside baseDir. */
export function resolveInside(baseDir, relPath) {
  const normalized = normalizeRelPath(relPath);
  const full = path.resolve(baseDir, ...normalized.split('/'));
  const back = path.relative(baseDir, full);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw badRequest(`Path "${relPath}" points outside the project`);
  }
  return full;
}

const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.def', '.cfg', '.clo', '.dtx', '.ins', '.ltx',
  '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.tsv', '.tum', '.py', '.m', '.r', '.sh', '.lua',
  '.tikz', '.pgf', '.dat', '.xml', '.svg', '.html', '.css', '.js', '.latexmkrc', '.gitignore',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico', '.pdf', '.eps', '.ps',
  '.zip', '.gz', '.tgz', '.7z', '.otf', '.ttf', '.woff', '.woff2', '.pfb', '.tfm', '.mp4', '.mov', '.docx', '.xlsx',
]);

/** Whether a file should open in the text editor (by extension, falling back to a NUL-byte sniff). */
export function isTextFile(relPath, sample) {
  const base = path.posix.basename(relPath).toLowerCase();
  const ext = base.startsWith('.') && !base.slice(1).includes('.') ? base : path.posix.extname(base);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (!sample || BINARY_EXTENSIONS.has(ext)) return false;
  return !sample.subarray(0, 8000).includes(0);
}
