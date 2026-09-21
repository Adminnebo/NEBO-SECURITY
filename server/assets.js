import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
});

const PUBLIC_ENTRY_FILES = new Set(['login.js', 'auth.css', 'theme.js']);
const FORBIDDEN_PARTS = new Set(['node_modules', '.git', '.wrangler', '__pycache__']);

// Keep the public/private split identical to package_site_worker.py. This
// binding is reachable only through worker/index.js and never mounted directly.
export function isPublicAssetPath(relativePath) {
  return relativePath.startsWith('assets/') || relativePath.startsWith('vendor/') || PUBLIC_ENTRY_FILES.has(relativePath);
}

export function isSafeAssetPath(relativePath) {
  if (!relativePath || /[\\:\u0000-\u001f\u007f]/.test(relativePath) || relativePath.startsWith('/')) return false;
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || FORBIDDEN_PARTS.has(part.toLowerCase()))) return false;
  const filename = parts.at(-1).toLowerCase();
  return !filename.startsWith('.env') && !filename.startsWith('.dev.vars') &&
    !/\.(?:pem|p12|pfx|sqlite|sqlite3|db|key|key\.txt)$/.test(filename);
}

export function decodeAssetPath(pathname) {
  if (!pathname.startsWith('/') || /%2f|%5c/i.test(pathname)) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname.slice(1)); } catch { return null; }
  return isSafeAssetPath(decoded) ? decoded : null;
}

function isInside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function missing() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function createAssetBinding(publicDirectory) {
  const source = path.resolve(publicDirectory);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Invalid public asset directory');
  const root = await realpath(source);
  return Object.freeze({
    async fetch(request) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      const relative = decodeAssetPath(new URL(request.url).pathname);
      if (!relative || !isPublicAssetPath(relative)) return missing();
      const candidate = path.resolve(root, ...relative.split('/'));
      if (!isInside(root, candidate)) return missing();
      try {
        // Reject aliases as well as escapes: an allowlisted logo must not become
        // a symlink to a private document elsewhere inside the public tree.
        const filename = await realpath(candidate);
        if (!isInside(root, filename) || filename !== candidate) return missing();
        const details = await stat(filename);
        if (!details.isFile()) return missing();
        const headers = {
          'Content-Type': MIME_TYPES[path.extname(relative)] || 'application/octet-stream',
          'Content-Length': String(details.size),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        };
        return new Response(request.method === 'HEAD' ? null : await readFile(filename), { headers });
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) return missing();
        throw error;
      }
    },
  });
}
