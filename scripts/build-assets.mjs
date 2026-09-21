import { lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPublicAssetPath, isSafeAssetPath, MIME_TYPES } from '../server/assets.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export async function buildAssets(root = repositoryRoot) {
  const publicDirectory = path.join(root, 'public');
  const workerDirectory = path.join(root, 'worker');
  for (const directory of [publicDirectory, workerDirectory]) {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Build directories must be real directories');
  }
  const entries = [];
  async function visit(directory, prefix = '') {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relative = prefix + child.name;
      if (!isSafeAssetPath(relative)) throw new Error('Unsafe application asset path');
      const filename = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error('Symlinks are not allowed in application assets');
      if (child.isDirectory()) await visit(filename, relative + '/');
      else if (!child.isFile()) throw new Error('Application assets must be regular files');
      else if (!isPublicAssetPath(relative)) entries.push([
        '/' + relative,
        [MIME_TYPES[path.extname(relative)] || 'application/octet-stream', (await readFile(filename)).toString('base64')],
      ]);
    }
  }
  await visit(publicDirectory);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!entries.some(([name]) => name === '/index.html')) throw new Error('Missing private application HTML');
  const payload = JSON.stringify(Object.fromEntries(entries)).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const module = `// Generated from application assets; never publish as a static client file.
const assets = Object.freeze(${payload});
export function servePrivateAsset(request, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = pathname.startsWith('/') ? pathname : '/' + pathname;
  if (!Object.hasOwn(assets, path)) return null;
  const [mime, encoded] = assets[path];
  const headers = {
    'Content-Type': mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return new Response(bytes, { headers });
}
`;
  const destination = path.join(workerDirectory, 'site-assets.js');
  try {
    const details = await lstat(destination);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Invalid generated asset destination');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(workerDirectory, `.site-assets-${process.pid}.tmp`);
  await writeFile(temporary, module, { flag: 'wx' });
  await rename(temporary, destination);
  return { generated: 'worker/site-assets.js', bytes: Buffer.byteLength(module), privateAssets: entries.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await buildAssets())); }
  catch { console.error('Asset build failed: check application asset paths and required files.'); process.exitCode = 1; }
}
