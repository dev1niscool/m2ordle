import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
for (const directory of ['public', 'server', 'scripts', 'tests']) {
  for (const file of await readdir(join(root, directory), { withFileTypes: true })) {
    if (!file.isFile() || !/\.(js|mjs)$/.test(file.name)) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, directory, file.name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    checked += 1;
  }
}
console.log(`Syntax checked ${checked} JavaScript files.`);
