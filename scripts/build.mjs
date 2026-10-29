import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_FILES = [
  'index.html', 'app.js', 'styles.css', 'config.js', 'shared.js',
  'admin.html', 'admin.js', 'admin.css', 'favicon.svg', 'robots.txt', 'manifest.webmanifest',
];
const REQUIRED_FILES = ['index.html', 'app.js', 'styles.css', 'admin.html', 'admin.js', 'admin.css'];

function validateApiBase(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('M2ORDLE_API_URL must be an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('M2ORDLE_API_URL must be an HTTPS origin with no path, credentials, query, or fragment.');
  }
  return url.origin;
}

async function copyPublic(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const file of PUBLIC_FILES) {
    if (file === 'config.js') continue; // Always generated; never copies local credentials/config.
    try { await copyFile(join(source, file), join(destination, file)); }
    catch (error) { if (error.code !== 'ENOENT' || REQUIRED_FILES.includes(file)) throw error; }
  }
  for (const folder of ['assets', 'icons']) {
    let entries;
    try { entries = await readdir(join(source, folder), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-zA-Z0-9._-]+\.(svg|png|webp|ico|woff2)$/.test(entry.name)) continue;
      await mkdir(join(destination, folder), { recursive: true });
      await copyFile(join(source, folder, entry.name), join(destination, folder, entry.name));
    }
  }
}

export async function buildSite({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), staticOnly = false, apiBase = '' } = {}) {
  const api = validateApiBase(apiBase);
  const source = join(root, 'public');
  const dist = join(root, 'dist');
  const workerDist = join(root, 'dist-worker');
  let files = [];
  if (!staticOnly) {
    const groups = JSON.parse(await readFile(join(root, 'server/photos.json'), 'utf8'));
    if (!Array.isArray(groups) || !groups.length) throw new Error('No reviewed portrait groups found. Import the reference library first.');
    const photoIds = new Set();
    const groupIds = new Set();
    for (const group of groups) {
      if (!group.id || groupIds.has(group.id) || !Array.isArray(group.photos) || !group.photos.length) throw new Error('Invalid or duplicate portrait group.');
      groupIds.add(group.id);
      if (!group.photos.some(photo => photo.path === group.cover)) throw new Error('A group cover must be one of its source photographs.');
      for (const photo of group.photos) {
        if (!photo.id || photoIds.has(photo.id) || !/^\/_portraits\/[a-zA-Z0-9_-]+\.jpg$/.test(photo.path)) throw new Error('Invalid or duplicate photograph.');
        photoIds.add(photo.id);
        if (!Number.isInteger(photo.width) || photo.width < 1 || !Number.isInteger(photo.height) || photo.height < 1) throw new Error('Photo dimensions are required.');
        const filename = photo.path.slice('/_portraits/'.length);
        if (files.includes(filename)) throw new Error('Duplicate photograph path.');
        const image = await stat(join(root, 'private/portraits', filename));
        if (!image.isFile() || image.size === 0) throw new Error(`Missing portrait: ${filename}`);
        files.push(filename);
      }
    }
  }
  // Only generated output is replaced. Neither the roster PDF nor private source is touched.
  await rm(dist, { recursive: true, force: true });
  await copyPublic(source, dist);
  await writeFile(join(dist, 'config.js'), `window.M2ORDLE_CONFIG = ${JSON.stringify({ apiBase: api })};\n`);
  await writeFile(join(dist, '.nojekyll'), '');
  if (!staticOnly) {
    await rm(workerDist, { recursive: true, force: true });
    await copyPublic(source, workerDist);
    await writeFile(join(workerDist, 'config.js'), 'window.M2ORDLE_CONFIG = {"apiBase":""};\n');
    await mkdir(join(workerDist, '_portraits'), { recursive: true });
    for (const filename of files) await copyFile(join(root, 'private/portraits', filename), join(workerDist, '_portraits', filename));
  }
  return { publicDirectory: dist, workerDirectory: staticOnly ? null : workerDist, photoCount: files.length, apiBase: api };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSite({ staticOnly: process.argv.includes('--static-only'), apiBase: process.env.M2ORDLE_API_URL || '' });
  console.log(`Built public frontend${result.workerDirectory ? ` and Worker assets (${result.photoCount} protected portraits)` : ''}. API: ${result.apiBase || 'same origin'}.`);
}
