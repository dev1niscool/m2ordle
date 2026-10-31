import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../scripts/build.mjs';
import {exportClassmates, parseClassmates, renderClassmates} from '../scripts/export-classmates.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'm2ordle-build-'));
  for (const directory of ['public/assets', 'private/portraits', 'server']) await mkdir(join(root, directory), { recursive: true });
  for (const file of ['index.html', 'app.js', 'styles.css', 'admin.html', 'admin.js', 'admin.css']) await writeFile(join(root, 'public', file), 'fixture');
  await writeFile(join(root, 'public/assets/m2ordle.svg'), '<svg/>');
  await writeFile(join(root, 'public/assets/secret.json'), '{"table":31}');
  await writeFile(join(root, 'public/roster.json'), '{"table":31}');
  await writeFile(join(root, 'public/config.js'), 'SECRET_LOCAL_CONFIG');
  await writeFile(join(root, 'private/portraits/photo.jpg'), 'JPEG fixture bytes');
  await writeFile(join(root, 'private/portraits/unselected.jpg'), 'not in manifest');
  await writeFile(join(root, 'server/photos.json'), JSON.stringify([{ id: 'group', cover: '/_portraits/photo.jpg', photos: [{ id: 'photo', path: '/_portraits/photo.jpg', width: 424, height: 641 }] }]));
  await writeFile(join(root, 'server/roster.json'), JSON.stringify([{ id: 'private-name', name: 'Private Name', table: '31' }]));
  await writeFile(join(root, 'server/lookbook.json'), JSON.stringify([{id:'private-name', name:'Private Name', sourceName:'Private Name', page:1, facts:['A private fact.', 'Another private fact.', 'A third private fact.']}]));
  await writeFile(join(root, 'public/lookbook.json'), 'PRIVATE_LOOKBOOK_FACTS');
  await exportClassmates(root);
  return root;
}

async function files(directory, prefix = '') {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) out.push(...await files(join(directory, entry.name), name + '/'));
    else out.push(name);
  }
  return out;
}

test('build keeps tables, private source, and portraits out of Pages; Worker gets selected originals only', async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await buildSite({ root, apiBase: 'https://example.workers.dev/' });
  const publicFiles = await files(join(root, 'dist'));
  assert(!publicFiles.some(name => /portraits|roster|secret|lookbook/.test(name)));
  assert(publicFiles.includes('assets/m2ordle.svg'));
  assert.deepEqual(parseClassmates(await readFile(join(root, 'dist/classmates.js'), 'utf8')), [{id:'private-name', name:'Private Name'}]);
  assert.equal(await readFile(join(root, 'dist/config.js'), 'utf8'), 'window.M2ORDLE_CONFIG = {"apiBase":"https://example.workers.dev"};\n');
  const workerFiles = await files(join(root, 'dist-worker'));
  assert(workerFiles.includes('_portraits/photo.jpg'));
  assert(!workerFiles.includes('_portraits/unselected.jpg'));
  assert(!workerFiles.some(name => /roster|secret|lookbook/.test(name)));
  assert.equal(await readFile(join(root, 'dist-worker/classmates.js'), 'utf8'), await readFile(join(root, 'dist/classmates.js'), 'utf8'));
  assert.equal(await readFile(join(root, 'dist-worker/config.js'), 'utf8'), 'window.M2ORDLE_CONFIG = {"apiBase":""};\n');
});

test('static-only build works without private data or server manifests', async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(join(root, 'private'), { recursive: true });
  await rm(join(root, 'server'), { recursive: true });
  const result = await buildSite({ root, staticOnly: true });
  assert.equal(result.workerDirectory, null);
  await access(join(root, 'dist/index.html'));
  assert.deepEqual(parseClassmates(await readFile(join(root, 'dist/classmates.js'), 'utf8')), [{id:'private-name', name:'Private Name'}]);
  await assert.rejects(access(join(root, 'dist-worker')));
});

test('full builds require a valid lookbook import tied to unique roster names', async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'server/lookbook.json');
  const [entry] = JSON.parse(await readFile(filename, 'utf8'));
  for (const bad of [[{...entry, facts:['only one']}], [{...entry, id:'not-on-roster'}], [{...entry, name:'Different Name'}], [entry,entry]]) {
    await writeFile(filename, JSON.stringify(bad));
    await assert.rejects(buildSite({root}), /lookbook|matched classmate/i);
  }
  await rm(filename);
  await assert.rejects(buildSite({root}), /ENOENT/);
});

test('public name export drops private fields and builds reject stale or unsafe bundles', async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const roster = [{id:'one', name:'First Classmate', table:7, secret:'private'}, {id:'two', name:'Second Classmate', table:12}];
  const source = renderClassmates(roster);
  assert.deepEqual(parseClassmates(source), [{id:'one', name:'First Classmate'}, {id:'two', name:'Second Classmate'}]);
  assert.doesNotMatch(source, /table|secret|private/);
  await writeFile(join(root, 'public/classmates.js'), source);
  await assert.rejects(buildSite({root}), /public names differ/);
  await writeFile(join(root, 'public/classmates.js'), source.replace('"name": "First Classmate"', '"name": "First Classmate", "table": 7'));
  await assert.rejects(buildSite({root, staticOnly:true}), /only IDs and names/);
  await rm(join(root, 'public/classmates.js'));
  await assert.rejects(buildSite({root, staticOnly:true}), /ENOENT/);
});

test('build rejects untrusted API origins and missing protected assets', async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const apiBase of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?token=secret']) {
    await assert.rejects(buildSite({ root, apiBase }), /HTTPS origin/);
  }
  await rm(join(root, 'private/portraits/photo.jpg'));
  await assert.rejects(buildSite({ root }), /ENOENT/);
});
