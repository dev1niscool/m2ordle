import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker, {M2ordle} from '../server/worker.js';
import roster from '../server/roster.json' with {type: 'json'};
import photos from '../server/photos.json' with {type: 'json'};
import {centralDate, nextCentralMidnight, calculateStats} from '../server/core.js';

const ADMIN = 'fixture-admin-password-more-than-20-characters';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([255, 216, ...Array(24).fill(0), 255, 217]).toString('base64');
const TODAY = '2026-10-29';
const ANSWER = roster[0];
const PHOTO = photos[0].photos[0];
const FACTS = ['I collect postcards.', 'I can juggle three oranges.', 'I learned to bake bread.'];
function puzzle(date = TODAY, extra = {}) {
  return {date, personId: ANSWER.id, photoId: PHOTO.id, crops: [.12, .25, .45, .7, 1].map(size => ({x: 0, y: 0, size})), images: Array(5).fill(JPEG), reveal: JPEG, published: true, ...extra};
}
function factPuzzle(date = TODAY, extra = {}) {
  return puzzle(date, {useLookbook: true, crops: [.2, .5, 1].map(size => ({x: 0, y: 0, size})), images: Array(3).fill(JPEG), ...extra});
}
function fixture(t, env = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = {exec(query, ...args) {
    if (query.includes('CREATE TABLE')) { db.exec(query); return {toArray: () => []}; }
    const statement = db.prepare(query);
    if (statement.columns().length) return {toArray: () => statement.all(...args)};
    statement.run(...args); return {toArray: () => []};
  }};
  const ctx = {storage: {sql, transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }}};
  const config = {ADMIN_PASSWORD: ADMIN, ...env};
  let now = Date.parse(TODAY + 'T17:00:00Z');
  let room, fixtureLookbook = null;
  function restart() { room = new M2ordle(ctx, config); room.now = () => now; if (fixtureLookbook) room.lookbook = new Map(fixtureLookbook); }
  restart();
  async function raw(path, body, token, ip = 'fixture') {
    return room.fetch(new Request('https://m2ordle.test' + path, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(token ? {Authorization: 'Bearer ' + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
  }
  async function call(path, body, token, ip) {
    const response = await raw('/api/' + path, body, token, ip);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return {code: response.status, ...await response.json()};
  }
  async function publish(date = TODAY, extra) { return call('admin/puzzle', puzzle(date, extra), ADMIN); }
  async function start(ip) {
    const session = await call('session', {}, undefined, ip);
    assert.equal(session.code, 201);
    return {token: session.token, game: await call('game', undefined, session.token, ip)};
  }
  let request = 0;
  async function guess(token, personId = ANSWER.id, extra = {}) { return call('guess', {personId, requestId: 'fixture-' + ++request, ...extra}, token); }
  return {db, ctx, config, raw, call, publish, start, guess, restart, setTime: value => {now = Date.parse(value);}, setLookbook: entries => {fixtureLookbook = new Map(entries); room.lookbook = new Map(fixtureLookbook);}, get room() {return room;}};
}

test('Central dates and midnight resets handle both DST transitions', () => {
  assert.equal(centralDate('2026-10-30T04:59:59Z'), '2026-10-29');
  assert.equal(centralDate('2026-10-30T05:00:00Z'), '2026-10-30');
  assert.equal(nextCentralMidnight('2026-03-08T06:00:00Z'), '2026-03-09T05:00:00.000Z');
  assert.equal(nextCentralMidnight('2026-11-01T05:00:00Z'), '2026-11-02T06:00:00.000Z');
  assert.equal(nextCentralMidnight('2026-03-07T18:00:00Z'), '2026-03-08T06:00:00.000Z');
});

test('empty days explain missing content; roster never exposes table assignments', async t => {
  const f = fixture(t);
  assert.equal((await f.call('health')).ok, true);
  assert.equal((await f.call('game')).code, 401);
  const {game} = await f.start();
  assert.equal(game.available, false);
  assert.match(game.message, /contact Devin/);
  const publicRoster = await f.call('roster');
  assert.equal(publicRoster.people.length, roster.length);
  assert.deepEqual(Object.keys(publicRoster.people[0]).sort(), ['id', 'name']);
  assert.equal((await f.call('admin/photos')).code, 401);
  assert.equal((await f.call('admin/puzzle?date=' + TODAY)).code, 401);
  assert.equal((await f.call('admin/auth', undefined, ADMIN)).code, 200);
});

test('missing weekend puzzles show the Monday message without creating games or scores', async t => {
  const f = fixture(t);
  const {token} = await f.call('session', {});
  for (const [now, date, nextReset] of [
    ['2026-10-31T17:00:00Z', '2026-10-31', '2026-11-01T05:00:00.000Z'],
    ['2026-11-01T17:00:00Z', '2026-11-01', '2026-11-02T06:00:00.000Z'],
  ]) {
    f.setTime(now);
    const game = await f.call('game', undefined, token);
    assert.deepEqual(game, {code: 200, available: false, reason: 'weekend', date, nextReset, message: 'Come back Monday for the next M2ordle.'});
    assert.equal((await f.guess(token)).code, 409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM games').get().count, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claims').get().count, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM guess_requests').get().count, 0);
  }
});

test('weekend drafts stay closed but publishing a weekend puzzle makes it playable', async t => {
  const f = fixture(t);
  const {token} = await f.call('session', {});
  for (const date of ['2026-10-31', '2026-11-01']) {
    f.setTime(date + 'T17:00:00Z');
    assert.equal((await f.publish(date, {published: false})).code, 200);
    const draft = await f.call('game', undefined, token);
    assert.equal(draft.available, false);
    assert.equal(draft.reason, 'weekend');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM games WHERE date=?').get(date).count, 0);
    assert.equal((await f.publish(date)).code, 200);
    const published = await f.call('game', undefined, token);
    assert.equal(published.available, true);
    assert.equal(published.status, 'playing');
    assert.equal('reason' in published, false);
    assert.equal((await f.guess(token)).status, 'won');
  }
});

test('weekend closure follows Central midnight through the fall daylight-saving change', async t => {
  const f = fixture(t);
  const {token} = await f.call('session', {});
  for (const [now, date, weekend, nextReset] of [
    ['2026-10-31T04:59:59Z', '2026-10-30', false, '2026-10-31T05:00:00.000Z'],
    ['2026-10-31T05:00:00Z', '2026-10-31', true, '2026-11-01T05:00:00.000Z'],
    ['2026-11-01T05:00:00Z', '2026-11-01', true, '2026-11-02T06:00:00.000Z'],
    ['2026-11-02T05:59:59Z', '2026-11-01', true, '2026-11-02T06:00:00.000Z'],
    ['2026-11-02T06:00:00Z', '2026-11-02', false, '2026-11-03T06:00:00.000Z'],
  ]) {
    f.setTime(now);
    const game = await f.call('game', undefined, token);
    assert.equal(game.available, false);
    assert.equal(game.date, date);
    assert.equal(game.reason === 'weekend', weekend);
    assert.equal(game.message, weekend ? 'Come back Monday for the next M2ordle.' : "Check again, or contact Devin to update today's M2ordle.");
    assert.equal(game.nextReset, nextReset);
  }
});

test('admin validates dates, crop bounds, progression, portraits and JPEG payloads', async t => {
  const f = fixture(t);
  assert.equal((await f.publish('2026-02-30')).code, 400);
  assert.equal((await f.publish(TODAY, {photoId: 'unknown'})).code, 400);
  assert.equal((await f.publish(TODAY, {crops: [.5, .4, .6, .8, 1].map(size => ({x: 0, y: 0, size}))})).code, 400);
  assert.equal((await f.publish(TODAY, {crops: Array(5).fill({x: 0, y: .9, size: 1})})).code, 400);
  assert.equal((await f.publish(TODAY, {images: Array(5).fill('data:image/jpeg;base64,eHl6')})).code, 400);
  assert.equal((await f.publish(TODAY, {published: false})).code, 200);
  assert.equal((await f.start()).game.available, false);
  assert.equal((await f.publish()).code, 200);
  const result = await f.call('admin/calendar?month=2026-10', undefined, ADMIN);
  assert.equal(result.days[0].name, ANSWER.name);
  assert.equal(result.days[0].published, true);
  assert.equal((await f.call('admin/calendar?month=2026-99', undefined, ADMIN)).code, 400);
});

test('lookbook facts are available only in the admin roster and saved by the selected clue format', async t => {
  const f = fixture(t); f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  assert.equal((await f.call('admin/roster')).code, 401);
  const adminRoster = await f.call('admin/roster', undefined, ADMIN);
  assert.deepEqual(adminRoster.people.find(person => person.id === ANSWER.id), {id: ANSWER.id, name: ANSWER.name, lookbookFacts: FACTS});
  assert.deepEqual(adminRoster.people.find(person => person.id === roster[1].id).lookbookFacts, []);
  assert.ok(adminRoster.people.every(person => !('table' in person)));
  const publicRoster = await f.call('roster');
  assert.ok(publicRoster.people.every(person => Object.keys(person).sort().join(',') === 'id,name'));
  for (const body of [
    factPuzzle(TODAY, {personId: roster[1].id}), factPuzzle(TODAY, {useLookbook: 'true'}),
    factPuzzle(TODAY, {crops: puzzle().crops}), factPuzzle(TODAY, {images: Array(5).fill(JPEG)}),
    factPuzzle(TODAY, {useLookbook: false}),
  ]) assert.equal((await f.call('admin/puzzle', body, ADMIN)).code, 400);
  const saved = await f.call('admin/puzzle', factPuzzle(TODAY, {facts: ['Injected', 'facts', 'ignored']}), ADMIN);
  assert.equal(saved.code, 200);
  assert.deepEqual(saved.puzzle.facts, FACTS);
  assert.equal(saved.puzzle.useLookbook, true);
  assert.equal(saved.puzzle.crops.length, 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM images WHERE date=?').get(TODAY).count, 4);
  assert.deepEqual((await f.call('admin/puzzle?date=' + TODAY, undefined, ADMIN)).puzzle.facts, FACTS);
  const normal = await f.publish('2026-10-30');
  assert.deepEqual(normal.puzzle.facts, []);
  assert.equal(normal.puzzle.useLookbook, false, 'old clients and photo-only saves stay on five photo clues');
});

test('lookbook games unlock one fact, three facts, then three photos without premature image access', async t => {
  const f = fixture(t); f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  assert.equal((await f.call('admin/puzzle', factPuzzle(), ADMIN)).code, 200);
  const {token, game} = await f.start();
  assert.deepEqual(game.clue, {type: 'facts', facts: FACTS.slice(0, 1)});
  assert.equal(game.image, null);
  assert.equal(game.maxGuesses, 5);
  assert.equal('answer' in game, false);
  assert.equal(JSON.stringify(game).includes(FACTS[1]), false);
  assert.equal(JSON.stringify(game).includes(FACTS[2]), false);
  assert.equal('personId' in game.clue, false);
  for (const stage of ['0', '1', '2', '3', '4', 'reveal']) assert.equal((await f.raw(`/api/image?date=${TODAY}&stage=${stage}`, undefined, token)).status, 403);
  let next = await f.guess(token, roster[1].id);
  assert.deepEqual(next.clue, {type: 'facts', facts: FACTS});
  assert.equal(next.image, null);
  assert.equal('answer' in next, false);
  assert.equal((await f.raw(`/api/image?date=${TODAY}&stage=0`, undefined, token)).status, 403);
  f.restart();
  assert.deepEqual(await f.call('game', undefined, token), next);
  for (let wrong = 2; wrong <= 4; wrong++) {
    next = await f.guess(token, roster[wrong].id);
    assert.deepEqual(next.clue, {type: 'photo'});
    assert.equal(next.image, `/api/image?date=${TODAY}&stage=${wrong - 2}`);
    assert.equal((await f.raw(next.image, undefined, token)).status, 200);
    assert.equal((await f.raw(`/api/image?date=${TODAY}&stage=${wrong - 1}`, undefined, token)).status, 403);
    assert.equal((await f.raw(`/api/image?date=${TODAY}&stage=reveal`, undefined, token)).status, 403);
    assert.equal('answer' in next, false);
    assert.equal('facts' in next, false);
  }
  const lost = await f.guess(token, roster[5].id);
  assert.equal(lost.status, 'lost');
  assert.equal(lost.guesses.length, 5);
  assert.equal(lost.points, 0);
  assert.equal(lost.answer.id, ANSWER.id);
  assert.equal((await f.raw(lost.image, undefined, token)).status, 200);
  for (const stage of ['0', '1', '2']) assert.equal((await f.raw(`/api/image?date=${TODAY}&stage=${stage}`, undefined, token)).status, 200);
  for (const stage of ['3', '4']) assert.equal((await f.raw(`/api/image?date=${TODAY}&stage=${stage}`, undefined, token)).status, 403);
  assert.equal((await f.guess(token)).code, 409);
});

test('a correct fact-stage guess reveals the answer without unlocking unseen photo clues', async t => {
  const f = fixture(t); f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  await f.call('admin/puzzle', factPuzzle(), ADMIN);
  for (const attempts of [1, 2]) {
    const {token} = await f.start();
    if (attempts === 2) await f.guess(token, roster[1].id);
    const won = await f.guess(token);
    assert.equal(won.status, 'won');
    assert.equal(won.points, 6 - attempts);
    assert.equal(won.answer.id, ANSWER.id);
    assert.deepEqual(won.clue, {type: 'photo'});
    assert.equal((await f.raw(won.image, undefined, token)).status, 200);
    for (const stage of ['0', '1', '2', '3', '4']) assert.equal((await f.raw(`/api/image?date=${TODAY}&stage=${stage}`, undefined, token)).status, 403);
    const stats = await f.call('stats', undefined, token);
    assert.equal(stats.wins, 1);
    assert.equal(stats.distribution[attempts - 1], 1);
  }
});

test('saved lookbook facts survive library changes, copying, restarts, and played-day locks', async t => {
  const f = fixture(t); f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  await f.call('admin/puzzle', factPuzzle(), ADMIN);
  const {token} = await f.start();
  const saved = f.db.prepare('SELECT * FROM puzzles WHERE date=?').get(TODAY);
  f.setLookbook([[ANSWER.id, {facts: ['New first', 'New second', 'New third'], page: 3}]]);
  f.restart();
  assert.deepEqual((await f.call('game', undefined, token)).clue.facts, [FACTS[0]]);
  assert.equal((await f.call('admin/puzzle', factPuzzle(), ADMIN)).code, 409);
  const copy = await f.call('admin/copy', {sourceDate: TODAY, targetDate: '2026-10-30'}, ADMIN);
  assert.equal(copy.code, 200);
  assert.deepEqual(copy.puzzle.facts, FACTS);
  assert.equal(copy.puzzle.crops.length, 3);
  assert.equal(copy.puzzle.published, false);
  assert.equal(copy.puzzle.useLookbook, true);
  assert.deepEqual(f.db.prepare('SELECT stage,jpeg FROM images WHERE date=? ORDER BY stage').all(TODAY), f.db.prepare('SELECT stage,jpeg FROM images WHERE date=? ORDER BY stage').all('2026-10-30'));
  assert.deepEqual(f.db.prepare('SELECT * FROM puzzles WHERE date=?').get(TODAY), saved);
  f.db.prepare('DELETE FROM images WHERE date=? AND stage=?').run(TODAY, '1');
  assert.equal((await f.call('admin/copy', {sourceDate: TODAY, targetDate: '2026-10-31'}, ADMIN)).code, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM puzzles WHERE date=?').get('2026-10-31').count, 0);
});

test('legacy puzzle migration preserves existing five-photo games and never converts them automatically', async t => {
  const f = fixture(t); await f.publish();
  const {token} = await f.start(); const before = await f.guess(token, roster[1].id);
  const games = f.db.prepare('SELECT * FROM games').all(), images = f.db.prepare('SELECT * FROM images').all();
  f.db.exec('ALTER TABLE puzzles DROP COLUMN facts');
  f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  f.restart(); f.restart();
  assert.deepEqual(await f.call('game', undefined, token), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM games').all(), games);
  assert.deepEqual(f.db.prepare('SELECT * FROM images').all(), images);
  const admin = await f.call('admin/puzzle?date=' + TODAY, undefined, ADMIN);
  assert.deepEqual(admin.puzzle.facts, []);
  assert.equal(admin.puzzle.crops.length, 5);
  assert.equal(admin.puzzle.locked, true);
  assert.equal((await f.raw(before.image, undefined, token)).status, 200);
});

test('admin overview requires authentication and reports a Central-time schedule across month boundaries', async t => {
  const f = fixture(t);
  assert.equal((await f.call('admin/overview?date=' + TODAY)).code, 401);
  for (const suffix of ['', '?date=2026-02-30', '?date=not-a-date']) assert.equal((await f.call('admin/overview' + suffix, undefined, ADMIN)).code, 400);
  await f.publish();
  await f.publish('2026-11-01', {published: false});
  await f.publish('2026-11-02');
  await f.start();
  f.setTime('2026-10-30T04:59:59Z');
  const overview = await f.call('admin/overview?date=' + TODAY, undefined, ADMIN);
  assert.equal(overview.today, TODAY);
  assert.equal(overview.nextReset, '2026-10-30T05:00:00.000Z');
  assert.equal(overview.upcoming.length, 14);
  assert.deepEqual(overview.upcoming[0], {date: TODAY, published: true, name: ANSWER.name, locked: true});
  assert.deepEqual(overview.upcoming[1], {date: '2026-10-30', published: false, name: null, locked: false});
  assert.deepEqual(overview.upcoming.find(day => day.date === '2026-11-01'), {date: '2026-11-01', published: false, name: ANSWER.name, locked: false});
  assert.equal(overview.upcoming.at(-1).date, '2026-11-11');
  assert.equal((await f.call('admin/calendar?month=2026-10', undefined, ADMIN)).days[0].locked, true);
  f.setTime('2026-10-30T05:00:00Z');
  assert.equal((await f.call('admin/overview?date=' + TODAY, undefined, ADMIN)).today, '2026-10-30');
  f.setTime('2026-11-01T05:30:00Z');
  assert.equal((await f.call('admin/overview?date=' + TODAY, undefined, ADMIN)).nextReset, '2026-11-02T06:00:00.000Z');
});

test('admin activity counts completed, in-progress and claimed games without exposing identities', async t => {
  const f = fixture(t); await f.publish();
  const first = await f.start(), third = await f.start(), lost = await f.start(), playing = await f.start();
  await f.guess(first.token);
  await f.guess(third.token, roster[1].id); await f.guess(third.token, roster[2].id); await f.guess(third.token);
  for (let i = 1; i <= 5; i++) await f.guess(lost.token, roster[i].id);
  await f.guess(playing.token, roster[1].id);
  const identity = roster[10];
  await f.call('claim', {personId: identity.id, table: identity.table}, first.token);
  const {activity} = await f.call('admin/overview?date=' + TODAY, undefined, ADMIN);
  assert.deepEqual(activity, {date: TODAY, started: 4, completed: 3, wins: 2, failed: 1, winRate: 67, averageGuesses: 2, claimed: 1, distribution: [1, 0, 1, 0, 0]});
  for (const value of [first.token, third.token, lost.token, playing.token, identity.name]) assert.equal(JSON.stringify(activity).includes(value), false);
  const empty = (await f.call('admin/overview?date=2026-10-28', undefined, ADMIN)).activity;
  assert.deepEqual(empty, {date: '2026-10-28', started: 0, completed: 0, wins: 0, failed: 0, winRate: 0, averageGuesses: null, claimed: 0, distribution: [0, 0, 0, 0, 0]});
});

test('admin copies a played puzzle and every image into an empty draft without changing source results', async t => {
  const f = fixture(t); await f.publish();
  const player = await f.start(); await f.guess(player.token);
  const identity = roster[10];
  await f.call('claim', {personId: identity.id, table: identity.table}, player.token);
  const source = f.db.prepare('SELECT * FROM puzzles WHERE date=?').get(TODAY);
  const images = f.db.prepare('SELECT stage,jpeg FROM images WHERE date=? ORDER BY stage').all(TODAY);
  const games = f.db.prepare('SELECT * FROM games').all(), claims = f.db.prepare('SELECT * FROM claims').all(), epoch = f.db.prepare('SELECT * FROM settings').all();
  const copy = await f.call('admin/copy', {sourceDate: TODAY, targetDate: '2026-10-30', published: true}, ADMIN);
  assert.equal(copy.code, 200);
  assert.equal(copy.saved, true);
  assert.deepEqual(copy.puzzle, {date: '2026-10-30', personId: ANSWER.id, photoId: PHOTO.id, crops: puzzle().crops, facts: [], useLookbook: false, published: false, locked: false});
  assert.deepEqual(f.db.prepare('SELECT stage,jpeg FROM images WHERE date=? ORDER BY stage').all('2026-10-30'), images);
  assert.deepEqual(f.db.prepare('SELECT * FROM puzzles WHERE date=?').get(TODAY), source);
  assert.deepEqual(f.db.prepare('SELECT * FROM games').all(), games);
  assert.deepEqual(f.db.prepare('SELECT * FROM claims').all(), claims);
  assert.deepEqual(f.db.prepare('SELECT * FROM settings').all(), epoch);
  f.restart();
  assert.equal((await f.call('admin/puzzle?date=2026-10-30', undefined, ADMIN)).puzzle.published, false);
  f.setTime('2026-10-30T05:00:00Z');
  assert.equal((await f.call('game', undefined, player.token)).available, false);
});

test('admin copy rejects unauthorized, invalid, occupied and incomplete requests without overwriting data', async t => {
  const f = fixture(t); await f.publish();
  const body = {sourceDate: TODAY, targetDate: '2026-10-30'};
  assert.equal((await f.call('admin/copy', body)).code, 401);
  for (const update of [{sourceDate: '2026-02-30'}, {targetDate: 'invalid'}, {targetDate: TODAY}, {targetDate: '2026-10-28'}]) assert.equal((await f.call('admin/copy', {...body, ...update}, ADMIN)).code, 400);
  assert.equal((await f.call('admin/copy', {...body, sourceDate: '2026-10-28'}, ADMIN)).code, 404);
  await f.publish('2026-10-30', {published: false, personId: roster[1].id});
  const existing = f.db.prepare('SELECT * FROM puzzles WHERE date=?').get('2026-10-30');
  assert.equal((await f.call('admin/copy', body, ADMIN)).code, 409);
  assert.deepEqual(f.db.prepare('SELECT * FROM puzzles WHERE date=?').get('2026-10-30'), existing);
  await f.publish('2026-10-31');
  assert.equal((await f.call('admin/copy', {...body, targetDate: '2026-10-31'}, ADMIN)).code, 409);
  f.db.prepare('INSERT INTO games(session,date,created) VALUES (?,?,?)').run('fixture-orphan', '2026-11-01', 0);
  assert.equal((await f.call('admin/copy', {...body, targetDate: '2026-11-01'}, ADMIN)).code, 409);
  f.db.prepare('DELETE FROM images WHERE date=? AND stage=?').run(TODAY, 'reveal');
  assert.equal((await f.call('admin/copy', {...body, targetDate: '2026-11-02'}, ADMIN)).code, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM puzzles WHERE date=?').get('2026-11-02').n, 0);
  await f.publish();
  f.db.prepare('UPDATE images SET jpeg=? WHERE date=? AND stage=?').run('broken', TODAY, '2');
  assert.equal((await f.call('admin/copy', {...body, targetDate: '2026-11-02'}, ADMIN)).code, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM images WHERE date=?').get('2026-11-02').n, 0);
});

test('admin copy is atomic, refuses competing copies and uses Central dates for past-day protection', async t => {
  const f = fixture(t); await f.publish('2026-10-28');
  const body = {sourceDate: '2026-10-28', targetDate: TODAY};
  const exec = f.room.sql.exec;
  f.room.sql.exec = (query, ...args) => {if (query.startsWith('INSERT INTO images') && args[0] === TODAY && args[1] === '2') throw new Error('fixture copy failure'); return exec(query, ...args);};
  assert.equal((await f.call('admin/copy', body, ADMIN)).code, 500);
  f.room.sql.exec = exec;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM puzzles WHERE date=?').get(TODAY).n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM images WHERE date=?').get(TODAY).n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM images WHERE date=?').get('2026-10-28').n, 6);
  f.setTime('2026-10-30T04:59:59Z');
  const copies = await Promise.all([f.call('admin/copy', body, ADMIN), f.call('admin/copy', body, ADMIN)]);
  assert.deepEqual(copies.map(result => result.code).sort(), [200, 409]);
  f.setTime('2026-10-30T05:00:00Z');
  assert.equal((await f.call('admin/copy', body, ADMIN)).code, 400);
});

test('guesses are server scored, retry safe, persistent and unlock only earned crops', async t => {
  const f = fixture(t);
  await f.publish();
  const {token, game} = await f.start();
  assert.equal(game.number, 1);
  assert.equal(game.maxGuesses, 5);
  assert.equal('answer' in game, false);
  assert.equal('crops' in game, false);
  assert.equal(JSON.stringify(game).includes(PHOTO.id), false);
  assert.equal((await f.raw(game.image, undefined, token)).status, 200);
  assert.equal((await f.raw('/api/image?date=' + TODAY + '&stage=1', undefined, token)).status, 403);
  assert.equal((await f.raw('/api/image?date=' + TODAY + '&stage=reveal', undefined, token)).status, 403);
  const body = {personId: roster[1].id, requestId: 'retry-request'};
  const wrong = await f.call('guess', body, token);
  assert.equal(wrong.guesses.length, 1);
  assert.match(wrong.image, /stage=1$/);
  assert.deepEqual(await f.call('guess', body, token), wrong);
  assert.equal((await f.call('guess', {...body, personId: roster[2].id}, token)).code, 409);
  assert.equal((await f.guess(token, roster[1].id)).code, 409);
  assert.equal((await f.guess(token, 'invented')).code, 400);
  assert.equal((await f.raw('/api/image?date=' + TODAY + '&stage=1', undefined, token)).status, 200);
  assert.equal((await f.raw('/api/image?date=' + TODAY + '&stage=2', undefined, token)).status, 403);
  const won = await f.guess(token);
  assert.equal(won.status, 'won');
  assert.equal(won.points, 4);
  assert.equal(won.answer.name, ANSWER.name);
  assert.match(won.image, /stage=reveal$/);
  assert.equal((await f.raw(won.image, undefined, token)).status, 200);
  assert.equal((await f.raw('/api/image?date=' + TODAY + '&stage=2', undefined, token)).status, 403);
  assert.equal((await f.guess(token, roster[2].id)).code, 409);
  f.restart();
  assert.deepEqual(await f.call('game', undefined, token), won);
  const stats = await f.call('stats', undefined, token);
  assert.equal(stats.played, 1);
  assert.equal(stats.wins, 1);
  assert.deepEqual(stats.distribution, [0, 1, 0, 0, 0]);
});

test('exactly five wrong guesses end the puzzle and reveal the answer', async t => {
  const f = fixture(t); await f.publish();
  const {token} = await f.start();
  let result;
  for (let index = 1; index <= 5; index++) result = await f.guess(token, roster[index].id);
  assert.equal(result.status, 'lost');
  assert.equal(result.guesses.length, 5);
  assert.equal(result.points, 0);
  assert.equal(result.answer.name, ANSWER.name);
  assert.equal((await f.guess(token)).code, 409);
  const stats = await f.call('stats', undefined, token);
  assert.equal(stats.todayFailed, 1);
  assert.deepEqual(stats.todayDistribution, [0, 0, 0, 0, 0]);
});

test('leaderboard claims require a completed game and the private table; scores cannot be forged', async t => {
  const f = fixture(t); await f.publish();
  const a = await f.start(), b = await f.start();
  const identity = roster[10], other = roster[11];
  const claim = {personId: identity.id, table: identity.table, points: 9999, date: TODAY};
  assert.equal((await f.call('claim', claim, a.token)).code, 409);
  await f.guess(a.token);
  assert.equal((await f.call('claim', {...claim, table: 999}, a.token)).code, 401);
  const accepted = await f.call('claim', claim, a.token);
  assert.equal(accepted.claimed.name, identity.name);
  assert.deepEqual(await f.call('claim', claim, a.token), accepted);
  assert.equal((await f.call('claim', {personId: other.id, table: other.table}, a.token)).code, 409);
  await f.guess(b.token, roster[1].id);
  await f.guess(b.token);
  assert.equal((await f.call('claim', claim, b.token)).code, 409);
  assert.equal((await f.call('claim', {personId: other.id, table: other.table}, b.token)).code, 200);
  // Display names can coincide; the current player must be identified by roster ID.
  f.room.people.set(identity.id, {...identity, name: 'Same Display Name'});
  f.room.people.set(other.id, {...other, name: 'Same Display Name'});
  const board = await f.call('leaderboard', undefined, a.token);
  assert.deepEqual(board.entries.map(entry => [entry.rank, entry.points, entry.wins]), [[1, 5, 1], [2, 4, 1]]);
  assert.equal(board.entries[0].averageGuesses, 1);
  assert.equal('table' in board.entries[0], false);
  assert.ok(board.entries.every(entry => typeof entry.isYou === 'boolean'));
  assert.deepEqual(board.entries.filter(entry => entry.isYou).map(entry => entry.personId), [identity.id]);
  const otherBoard = await f.call('leaderboard', undefined, b.token);
  assert.deepEqual(otherBoard.entries.filter(entry => entry.isYou).map(entry => entry.personId), [other.id]);
  assert.deepEqual(otherBoard.entries.map(({isYou, ...entry}) => entry), board.entries.map(({isYou, ...entry}) => entry));
});

test('leaderboard reads are public without creating sessions, games or claims', async t => {
  const f = fixture(t);
  const snapshot = () => ({sessions: f.db.prepare('SELECT * FROM sessions').all(), games: f.db.prepare('SELECT * FROM games').all(), claims: f.db.prepare('SELECT * FROM claims').all()});
  const publicRead = async (token, expectedEntries = []) => {
    const before = snapshot();
    const result = await f.call('leaderboard', undefined, token);
    assert.equal(result.code, 200);
    assert.equal(result.date, TODAY);
    assert.equal(result.nextReset, '2026-10-30T05:00:00.000Z');
    assert.deepEqual(result.entries, expectedEntries);
    assert.deepEqual(snapshot(), before);
  };
  await publicRead();
  await publicRead('unknown-session');
  await f.publish();
  const scorer = await f.start(); await f.guess(scorer.token);
  const identity = roster[10], claim = {personId: identity.id, table: identity.table};
  assert.equal((await f.call('claim', claim, scorer.token)).code, 200);
  const board = await f.call('leaderboard', undefined, scorer.token);
  assert.equal(board.entries[0].name, identity.name);
  assert.deepEqual(board.entries.filter(entry => entry.isYou).map(entry => entry.personId), [identity.id]);
  const anonymousEntries = board.entries.map(entry => ({...entry, isYou: false}));
  await publicRead(undefined, anonymousEntries);
  await publicRead('unknown-session', anonymousEntries);
  const {token} = await f.call('session', {});
  await publicRead(token, anonymousEntries);
  await f.call('game', undefined, token);
  await publicRead(token, anonymousEntries);
  await f.guess(token);
  await publicRead(token, anonymousEntries);
  assert.equal((await f.call('claim', {personId: roster[11].id, table: 999}, token)).code, 401);
  await publicRead(token, anonymousEntries);
  // Expired browser sessions may still read the standings, but do not identify a player.
  f.db.prepare('DELETE FROM sessions WHERE token=?').run(scorer.token);
  await publicRead(scorer.token, anonymousEntries);
});

test('public leaderboard stays available across Central midnight and retains a verified player highlight', async t => {
  const f = fixture(t); await f.publish(); await f.publish('2026-10-30');
  const {token} = await f.start();
  await f.guess(token);
  const identity = roster[10], claim = {personId: identity.id, table: identity.table};
  assert.equal((await f.call('claim', claim, token)).code, 200);
  f.setTime('2026-10-30T04:59:59Z');
  assert.equal((await f.call('leaderboard', undefined, token)).code, 200);
  f.setTime('2026-10-30T05:00:00Z');
  const nextDay = await f.call('leaderboard', undefined, token);
  assert.equal(nextDay.code, 200);
  assert.equal(nextDay.date, '2026-10-30');
  assert.deepEqual(nextDay.entries.filter(entry => entry.isYou).map(entry => entry.personId), [identity.id]);
  assert.deepEqual(await f.call('leaderboard?date=' + TODAY, undefined, token), nextDay);
  const anonymous = await f.call('leaderboard');
  assert.equal(anonymous.code, 200);
  assert.deepEqual(anonymous.entries, nextDay.entries.map(entry => ({...entry, isYou: false})));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM games WHERE date=?').get('2026-10-30').count, 0);
  await f.call('game', undefined, token);
  for (let i = 1; i <= 5; i++) await f.guess(token, roster[i].id);
  assert.equal((await f.call('leaderboard', undefined, token)).code, 200);
  const result = await f.call('claim', claim, token);
  assert.equal(result.code, 200);
  assert.equal(result.status, 'lost');
  const board = await f.call('leaderboard', undefined, token);
  assert.equal(board.code, 200);
  assert.equal(board.date, '2026-10-30');
  assert.equal(board.nextReset, '2026-10-31T05:00:00.000Z');
  assert.deepEqual(board.entries.map(({points, wins, played}) => ({points, wins, played})), [{points: 5, wins: 1, played: 2}]);
  assert.deepEqual(board.entries.filter(entry => entry.isYou).map(entry => entry.personId), [identity.id]);
});

test('leaderboard highlights only the latest verified identity in a shared browser', async t => {
  const f = fixture(t); await f.publish(); await f.publish('2026-10-30');
  const {token} = await f.start(); await f.guess(token);
  const first = roster[10], latest = roster[11];
  assert.equal((await f.call('claim', {personId: first.id, table: first.table}, token)).code, 200);
  f.setTime('2026-10-30T05:00:00Z');
  await f.call('game', undefined, token); await f.guess(token);
  assert.equal((await f.call('claim', {personId: latest.id, table: latest.table}, token)).code, 200);
  f.restart();
  const board = await f.call('leaderboard', undefined, token);
  assert.equal(board.code, 200);
  assert.equal(board.entries.length, 2);
  assert.deepEqual(board.entries.filter(entry => entry.isYou).map(entry => entry.personId), [latest.id]);
});

test('table guessing limits survive restarts and apply across sessions on the same IP', async t => {
  const f = fixture(t); await f.publish();
  const a = await f.start(); await f.guess(a.token);
  const wrong = {personId: roster[8].id, table: 999};
  for (let i = 0; i < 5; i++) assert.equal((await f.call('claim', wrong, a.token)).code, 401);
  f.restart();
  assert.equal((await f.call('claim', {...wrong, table: roster[8].table}, a.token)).code, 429);
  for (let i = 0; i < 7; i++) {
    const player = await f.start(); await f.guess(player.token);
    assert.equal((await f.call('claim', wrong, player.token)).code, 401);
  }
  const blocked = await f.start(); await f.guess(blocked.token);
  assert.equal((await f.call('claim', wrong, blocked.token)).code, 429);
  f.setTime(TODAY + 'T17:16:00Z');
  assert.equal((await f.call('claim', {...wrong, table: roster[8].table}, a.token)).code, 200);
});

test('admin throttles only failures, survives restarts, and caps concurrent attempts', async t => {
  const f = fixture(t);
  const valid = await Promise.all(Array.from({length: 24}, () => f.call('admin/photos', undefined, ADMIN)));
  assert.ok(valid.every(result => result.code === 200));
  const attempts = await Promise.all(Array.from({length: 24}, () => f.call('admin/auth', undefined, 'wrong')));
  assert.equal(attempts.filter(result => result.code === 401).length, 8);
  assert.equal(attempts.filter(result => result.code === 429).length, 16);
  f.restart();
  assert.equal((await f.call('admin/auth', undefined, ADMIN)).code, 429);
  f.setTime(TODAY + 'T17:16:00Z');
  assert.equal((await f.call('admin/auth', undefined, ADMIN)).code, 200);
  f.config.ADMIN_PASSWORD = 'short';
  assert.equal((await f.call('admin/auth', undefined, 'short')).code, 503);
});

test('storage failures roll back a guess, and played puzzles cannot change', async t => {
  const f = fixture(t); await f.publish(); const {token} = await f.start();
  const exec = f.room.sql.exec;
  f.room.sql.exec = (query, ...args) => {if (query.startsWith('INSERT INTO guess_requests')) throw new Error('fixture failure'); return exec(query, ...args);};
  assert.equal((await f.guess(token)).code, 500);
  f.room.sql.exec = exec;
  assert.equal((await f.call('game', undefined, token)).guesses.length, 0);
  assert.equal((await f.publish()).code, 409);
  assert.equal((await f.call('admin/puzzle?date=' + TODAY, undefined, ADMIN)).puzzle.locked, true);
  assert.equal((await f.publish('2026-10-28')).code, 409);
  assert.equal((await f.guess(token)).status, 'won');
});

test('Central rollover rejects stale submissions and puzzle numbers include skipped days', async t => {
  const f = fixture(t); await f.publish(); await f.publish('2026-10-31');
  const {token} = await f.start();
  f.setTime('2026-10-31T05:00:00Z');
  assert.equal((await f.guess(token, ANSWER.id, {date: TODAY})).code, 409);
  assert.equal((await f.guess(token)).code, 409);
  const next = await f.call('game', undefined, token);
  assert.equal(next.number, 3);
  assert.equal(next.date, '2026-10-31');
  assert.equal((await f.guess(token, ANSWER.id, {date: '2026-10-31'})).status, 'won');
  assert.equal((await f.call('claim', {personId: roster[3].id, table: roster[3].table, date: TODAY}, token)).code, 409);
});

test('original portraits require admin authentication even through encoded paths', async t => {
  const f = fixture(t);
  const env = {...f.config, ALLOWED_ORIGINS: 'https://class.test', M2ORDLE: {idFromName: name => name, get: () => ({fetch: request => f.room.fetch(request)})}, ASSETS: {fetch: () => new Response('portrait', {headers: {'Content-Type': 'image/jpeg'}})}};
  for (const path of [PHOTO.path, PHOTO.path.replace('_portraits', '%5fportraits'), PHOTO.path.replace('_portraits', '%255fportraits')]) {
    assert.equal((await worker.fetch(new Request('https://api.test' + path), env)).status, 401);
  }
  const portrait = await worker.fetch(new Request('https://api.test' + PHOTO.path, {headers: {Authorization: 'Bearer ' + ADMIN}}), env);
  assert.equal(portrait.status, 200);
  assert.equal(portrait.headers.get('Cache-Control'), 'private, no-store');
  const denied = await worker.fetch(new Request('https://api.test/api/health', {headers: {Origin: 'https://evil.test'}}), env);
  assert.equal(denied.status, 403);
  const options = await worker.fetch(new Request('https://api.test/api/guess', {method: 'OPTIONS', headers: {Origin: 'https://class.test'}}), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), 'https://class.test');
});

test('streaks break on missed or lost days and preserve yesterday’s ongoing streak', () => {
  const won = date => ({date, status: 'won', guesses: JSON.stringify([{correct: true}])});
  const rows = [won('2026-10-25'), won('2026-10-26'), won('2026-10-28')];
  const result = calculateStats(rows, '2026-10-29', []);
  assert.equal(result.streak, 1);
  assert.equal(result.maxStreak, 2);
  assert.equal(calculateStats(rows, '2026-10-30', []).streak, 0);
  rows.push({date: '2026-10-29', status: 'lost', guesses: '[]'});
  assert.equal(calculateStats(rows, '2026-10-29', []).streak, 0);
});

test('stats carry a Friday streak through closed weekend days and Monday across the fall DST change', async t => {
  const f = fixture(t);
  for (const date of [TODAY, '2026-10-30', '2026-11-02']) assert.equal((await f.publish(date)).code, 200);
  assert.equal((await f.publish('2026-10-31', {published: false})).code, 200);
  const {token} = await f.start(); await f.guess(token);
  f.setTime('2026-10-30T17:00:00Z');
  await f.call('game', undefined, token); await f.guess(token);
  const missedMonday = await f.start(); await f.guess(missedMonday.token);
  const savedGames = f.db.prepare('SELECT * FROM games ORDER BY session,date').all();
  const savedPuzzles = f.db.prepare('SELECT * FROM puzzles ORDER BY date').all();
  for (const now of ['2026-10-31T05:00:00Z', '2026-11-01T05:00:00Z', '2026-11-02T05:59:59Z', '2026-11-02T06:00:00Z']) {
    f.setTime(now); f.restart();
    const stats = await f.call('stats', undefined, token);
    assert.equal(stats.code, 200);
    assert.equal(stats.streak, 2, now);
    assert.equal(stats.maxStreak, 2);
    assert.equal(stats.played, 2);
    assert.equal(stats.wins, 2);
    assert.deepEqual(stats.distribution, [2, 0, 0, 0, 0]);
    assert.deepEqual(f.db.prepare('SELECT * FROM games ORDER BY session,date').all(), savedGames, 'closed days and stats reads do not create games');
    assert.deepEqual(f.db.prepare('SELECT * FROM puzzles ORDER BY date').all(), savedPuzzles, 'streak calculation does not change the published schedule');
  }
  await f.call('game', undefined, token);
  assert.equal((await f.call('stats', undefined, token)).streak, 2, 'Monday remains available to extend the streak');
  await f.guess(token);
  const monday = await f.call('stats', undefined, token);
  assert.equal(monday.streak, 3, 'a Monday win adds one, not three, to the Friday streak');
  assert.equal(monday.maxStreak, 3);
  assert.equal(monday.played, 3);
  f.setTime('2026-11-03T06:00:00Z');
  assert.equal((await f.call('stats', undefined, token)).streak, 3);
  const missed = await f.call('stats', undefined, missedMonday.token);
  assert.equal(missed.streak, 0, 'missing Monday still breaks the streak on Tuesday');
  assert.equal(missed.maxStreak, 1);
});

test('published weekend puzzles count toward streaks while missed and lost weekend puzzles break them', async t => {
  for (const weekendDate of ['2026-10-31', '2026-11-01']) {
    await t.test(weekendDate, async t => {
      const f = fixture(t);
      for (const date of ['2026-10-30', weekendDate, '2026-11-02']) assert.equal((await f.publish(date)).code, 200);
      f.setTime('2026-10-30T17:00:00Z');
      const winner = await f.start(), missed = await f.start(), loser = await f.start();
      for (const player of [winner, missed, loser]) await f.guess(player.token);
      f.setTime(weekendDate + 'T17:00:00Z');
      for (const player of [winner, missed, loser]) {
        await f.call('game', undefined, player.token);
        assert.equal((await f.call('stats', undefined, player.token)).streak, 1, 'today’s scheduled puzzle can still be completed');
      }
      await f.guess(winner.token);
      for (let i = 1; i <= 5; i++) await f.guess(loser.token, roster[i].id);
      assert.equal((await f.call('stats', undefined, loser.token)).streak, 0, 'a loss breaks the streak immediately');
      f.setTime(weekendDate === '2026-10-31' ? '2026-11-01T05:00:00Z' : '2026-11-02T06:00:00Z');
      f.restart();
      assert.equal((await f.call('stats', undefined, missed.token)).streak, 0, 'an unfinished published weekend puzzle is a missed day');
      assert.equal((await f.call('stats', undefined, winner.token)).streak, 2);
      f.setTime('2026-11-02T17:00:00Z');
      for (const [player, expectedStreak] of [[winner, 3], [missed, 1], [loser, 1]]) {
        await f.call('game', undefined, player.token); await f.guess(player.token);
        const stats = await f.call('stats', undefined, player.token);
        assert.equal(stats.streak, expectedStreak);
        assert.equal(stats.maxStreak, expectedStreak);
      }
    });
  }
});

test('historical best streaks skip only unpublished weekend gaps without adding free wins', () => {
  const won = date => ({date, status: 'won', guesses: JSON.stringify([{correct: true}])});
  const rows = ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-04'].map(won);
  const dates = rows.map(row => row.date);
  const stats = calculateStats(rows, '2026-11-04', [], dates);
  assert.equal(stats.maxStreak, 3, 'Thursday, Friday and Monday are consecutive wins across a closed weekend');
  assert.equal(stats.streak, 1, 'an unpublished Tuesday remains a weekday gap');
  assert.equal(stats.played, 4);
  assert.equal(stats.wins, 4);
  assert.deepEqual(stats.distribution, [4, 0, 0, 0, 0]);
  assert.equal(calculateStats(rows, '2026-11-04', [], [...dates, '2026-11-01']).maxStreak, 2, 'a missed published Sunday also separates historical streaks');
});

const STUDY_START = '2026-11-19';
const STUDY_NOW = '2026-11-19T06:00:00Z';
function competitionSnapshot(f) {
  return Object.fromEntries(['settings', 'puzzles', 'images', 'games', 'guess_requests', 'claims'].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function replayImage(id, stage) { return `/api/archive/image?replayId=${encodeURIComponent(id)}&stage=${stage}`; }
async function replayGuess(f, token, replayId, personId, requestId = crypto.randomUUID()) {
  return f.call('archive/guess', {replayId, personId, requestId}, token);
}

test('study mode starts at November 19 Central midnight and stops daily games and claims', async t => {
  const f = fixture(t);
  await f.publish('2026-11-18'); await f.publish(STUDY_START);
  f.setTime('2026-11-19T05:59:59Z');
  const before = await f.call('status');
  assert.equal(before.code, 200);
  assert.equal(before.date, '2026-11-18');
  assert.equal(before.mode, 'daily');
  assert.equal(before.archiveStarts, STUDY_START);
  assert.equal(before.nextReset, STUDY_NOW.replace('Z', '.000Z'));
  assert.notEqual((await f.call('archive')).code, 200);
  const winner = await f.start(), playing = await f.start();
  assert.equal(playing.game.available, true);
  const request = {personId: ANSWER.id, date: '2026-11-18', requestId: 'last-daily-guess'};
  assert.equal((await f.call('guess', request, winner.token)).status, 'won');
  const original = competitionSnapshot(f);
  f.setTime(STUDY_NOW);
  const after = await f.call('status');
  assert.equal(after.code, 200);
  assert.equal(after.date, STUDY_START);
  assert.equal(after.mode, 'archive');
  assert.equal(after.archiveStarts, STUDY_START);
  const daily = await f.call('game', undefined, playing.token);
  assert.equal(daily.code, 200);
  assert.equal(daily.available, false);
  assert.equal(daily.reason, 'study');
  assert.equal(daily.date, STUDY_START);
  assert.notEqual((await f.call('guess', request, winner.token)).code, 200, 'even old idempotent daily requests cannot continue the season');
  assert.notEqual((await f.guess(playing.token, ANSWER.id, {date: '2026-11-18'})).code, 200);
  assert.notEqual((await f.guess(playing.token, ANSWER.id, {date: STUDY_START})).code, 200);
  assert.notEqual((await f.call('claim', {personId: roster[10].id, table: roster[10].table, date: '2026-11-18'}, winner.token)).code, 200);
  assert.deepEqual(competitionSnapshot(f), original);
  f.setTime('2027-01-02T18:00:00Z'); f.restart();
  assert.equal((await f.call('status')).mode, 'archive');
  assert.equal((await f.call('game', undefined, playing.token)).reason, 'study', 'the weekend closure no longer replaces the study archive');
});

test('archive lists only published pre-study puzzles without answers, facts, or session mutations', async t => {
  const f = fixture(t); f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  await f.call('admin/puzzle', factPuzzle(), ADMIN);
  await f.publish('2026-11-17', {published: false});
  await f.publish('2026-11-18');
  await f.publish(STUDY_START); await f.publish('2026-12-01');
  const original = competitionSnapshot(f);
  f.setTime(STUDY_NOW);
  for (const token of [undefined, 'expired-session']) {
    const result = await f.call('archive', undefined, token);
    assert.equal(result.code, 200);
    assert.equal(result.date, STUDY_START);
    assert.deepEqual(result.entries, [
      {date: '2026-11-18', number: 21, clueType: 'photo'},
      {date: TODAY, number: 1, clueType: 'facts'},
    ]);
    assert.equal(JSON.stringify(result).includes(ANSWER.name), false);
    assert.equal(JSON.stringify(result).includes(FACTS[0]), false);
  }
  assert.deepEqual(competitionSnapshot(f), original);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  const empty = fixture(t); empty.setTime(STUDY_NOW);
  assert.deepEqual((await empty.call('archive')).entries, []);
});

test('archive replays require a valid session, resume progress, and restart independently', async t => {
  const f = fixture(t); await f.publish(); await f.publish('2026-11-18', {published: false}); await f.publish(STUDY_START);
  const {token} = await f.call('session', {}), other = await f.call('session', {});
  assert.notEqual((await f.call('archive/start', {date: TODAY}, token)).code, 200, 'archive cannot be opened before the cutoff');
  f.setTime(STUDY_NOW);
  assert.equal((await f.call('archive/start', {date: TODAY})).code, 401);
  assert.equal((await f.call('archive/start', {date: TODAY}, 'expired-session')).code, 401);
  for (const date of ['2026-02-30', 'not-a-date', '2026-10-28', '2026-11-18', STUDY_START, '2026-12-01']) {
    assert.notEqual((await f.call('archive/start', {date}, token)).code, 200, date);
  }
  const first = await f.call('archive/start', {date: TODAY}, token);
  assert.equal(first.code, 200);
  assert.equal(first.available, true);
  assert.equal(first.replay, true);
  assert.equal(typeof first.replayId, 'string');
  assert.ok(first.replayId.length >= 16);
  assert.equal(first.points, 0);
  assert.equal(first.nextReset, null);
  assert.deepEqual(first.guesses, []);
  assert.equal(first.status, 'playing');
  assert.equal(first.maxGuesses, 5);
  assert.equal('answer' in first, false);
  assert.equal((await f.raw(first.image, undefined, token)).status, 200);
  assert.equal((await f.raw(first.image)).status, 401);
  assert.notEqual((await f.raw(first.image, undefined, other.token)).status, 200);
  for (const path of ['archive/game?replayId=' + first.replayId, 'archive/game?replayId=invented']) {
    assert.notEqual((await f.call(path, undefined, other.token)).code, 200);
  }
  assert.notEqual((await replayGuess(f, other.token, first.replayId, ANSWER.id)).code, 200);
  const next = await replayGuess(f, token, first.replayId, roster[1].id);
  assert.equal(next.guesses.length, 1);
  assert.deepEqual(await f.call('archive/start', {date: TODAY}, token), next);
  f.restart();
  assert.deepEqual(await f.call('archive/game?replayId=' + first.replayId, undefined, token), next);
  const fresh = await f.call('archive/start', {date: TODAY, restart: true}, token);
  assert.notEqual(fresh.replayId, first.replayId);
  assert.equal(fresh.guesses.length, 0);
  assert.equal(fresh.status, 'playing');
  assert.deepEqual(await f.call('archive/start', {date: TODAY}, token), fresh, 'same-millisecond restarts resume the newest replay');
  assert.deepEqual(await f.call('archive/game?replayId=' + first.replayId, undefined, token), next, 'restart preserves the previous attempt');
  assert.notEqual((await f.raw(replayImage(fresh.replayId, '1'), undefined, token)).status, 200, 'the new attempt must unlock its own photos');
  assert.notEqual((await f.raw(`/api/image?date=${TODAY}&stage=0`, undefined, token)).status, 200, 'a replay does not unlock the daily image route');
  const separate = await f.call('archive/start', {date: TODAY}, other.token);
  assert.notEqual(separate.replayId, fresh.replayId);
  assert.equal(separate.guesses.length, 0);
});

test('lookbook replays reveal one fact, three facts, and three crops over exactly five guesses', async t => {
  const f = fixture(t); f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  await f.call('admin/puzzle', factPuzzle(), ADMIN);
  const {token} = await f.call('session', {}); f.setTime(STUDY_NOW);
  const original = competitionSnapshot(f);
  const first = await f.call('archive/start', {date: TODAY}, token), id = first.replayId;
  assert.equal(first.code, 200);
  assert.deepEqual(first.clue, {type: 'facts', facts: [FACTS[0]]});
  assert.equal(first.image, null);
  assert.equal(JSON.stringify(first).includes(FACTS[1]), false);
  assert.equal(JSON.stringify(first).includes(FACTS[2]), false);
  for (const stage of ['0', '1', '2', '3', '4', 'reveal']) assert.equal((await f.raw(replayImage(id, stage), undefined, token)).status, 403);
  let next = await replayGuess(f, token, id, roster[1].id, 'replay-first-miss');
  assert.deepEqual(next.clue, {type: 'facts', facts: FACTS});
  assert.equal(next.image, null);
  assert.deepEqual(await replayGuess(f, token, id, roster[1].id, 'replay-first-miss'), next);
  assert.equal((await replayGuess(f, token, id, roster[2].id, 'replay-first-miss')).code, 409);
  assert.equal((await replayGuess(f, token, id, roster[1].id)).code, 409);
  assert.equal((await f.raw(replayImage(id, '0'), undefined, token)).status, 403);
  for (let wrong = 2; wrong <= 4; wrong++) {
    next = await replayGuess(f, token, id, roster[wrong].id);
    assert.deepEqual(next.clue, {type: 'photo'});
    assert.equal(next.guesses.length, wrong);
    assert.equal(new URL(next.image, 'https://m2ordle.test').searchParams.get('stage'), String(wrong - 2));
    assert.equal((await f.raw(next.image, undefined, token)).status, 200);
    assert.equal((await f.raw(replayImage(id, String(wrong - 1)), undefined, token)).status, 403);
    assert.equal((await f.raw(replayImage(id, 'reveal'), undefined, token)).status, 403);
    assert.equal('answer' in next, false);
  }
  const lost = await replayGuess(f, token, id, roster[5].id, 'replay-final-miss');
  assert.equal(lost.status, 'lost');
  assert.equal(lost.guesses.length, 5);
  assert.equal(lost.points, 0);
  assert.equal(lost.answer.name, ANSWER.name);
  assert.equal(lost.nextReset, null);
  assert.equal((await f.raw(lost.image, undefined, token)).status, 200);
  assert.deepEqual(await replayGuess(f, token, id, roster[5].id, 'replay-final-miss'), lost);
  assert.equal((await replayGuess(f, token, id, ANSWER.id)).code, 409);
  for (const stage of ['0', '1', '2']) assert.equal((await f.raw(replayImage(id, stage), undefined, token)).status, 200);
  for (const stage of ['3', '4']) assert.equal((await f.raw(replayImage(id, stage), undefined, token)).status, 403);
  f.restart();
  assert.deepEqual(await f.call('archive/start', {date: TODAY}, token), lost);
  assert.deepEqual(competitionSnapshot(f), original);
});

test('early replay wins reveal the portrait without granting points or unseen photo clues', async t => {
  const f = fixture(t); f.setLookbook([[ANSWER.id, {facts: FACTS, page: 2}]]);
  await f.call('admin/puzzle', factPuzzle(), ADMIN);
  const {token} = await f.call('session', {}); f.setTime(STUDY_NOW);
  for (const attempts of [1, 2]) {
    const first = await f.call('archive/start', {date: TODAY, restart: true}, token), id = first.replayId;
    if (attempts === 2) await replayGuess(f, token, id, roster[1].id);
    const won = await replayGuess(f, token, id, ANSWER.id, 'same-id-on-distinct-replays');
    assert.equal(won.status, 'won');
    assert.equal(won.guesses.length, attempts);
    assert.equal(won.points, 0);
    assert.equal(won.answer.id, ANSWER.id);
    assert.equal('claimed' in won, false);
    assert.equal((await f.raw(won.image, undefined, token)).status, 200);
    for (const stage of ['0', '1', '2', '3', '4']) assert.equal((await f.raw(replayImage(id, stage), undefined, token)).status, 403);
    assert.notEqual((await f.call('claim', {personId: roster[10].id, table: roster[10].table, date: TODAY, replayId: id}, token)).code, 200);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 0);
  const stats = await f.call('stats', undefined, token);
  assert.equal(stats.played, 0);
  assert.equal(stats.wins, 0);
});

test('photo-only replays keep five crops and isolate request IDs and forged scoring fields', async t => {
  const f = fixture(t); await f.publish();
  const {token} = await f.call('session', {}); f.setTime(STUDY_NOW);
  let game = await f.call('archive/start', {date: TODAY}, token);
  const id = game.replayId;
  assert.deepEqual(game.clue, {type: 'photo'});
  for (let step = 0; step < 5; step++) {
    assert.equal(game.guesses.length, step);
    assert.equal(new URL(game.image, 'https://m2ordle.test').searchParams.get('stage'), String(step));
    assert.equal((await f.raw(game.image, undefined, token)).status, 200);
    assert.equal((await f.raw(replayImage(id, 'reveal'), undefined, token)).status, 403);
    if (step < 4) assert.equal((await f.raw(replayImage(id, String(step + 1)), undefined, token)).status, 403);
    game = await f.call('archive/guess', {replayId: id, personId: step === 4 ? ANSWER.id : roster[step + 1].id, requestId: `photo-guess-${step}`, points: 999, status: 'won', guesses: []}, token);
    assert.equal(game.code, 200);
    assert.equal(game.points, 0);
  }
  assert.equal(game.status, 'won');
  assert.equal(game.guesses.length, 5);
  assert.equal((await f.raw(game.image, undefined, token)).status, 200);
  const fresh = await f.call('archive/start', {date: TODAY, restart: true}, token);
  const freshWin = await replayGuess(f, token, fresh.replayId, ANSWER.id, 'photo-guess-0');
  assert.equal(freshWin.status, 'won');
  assert.equal(freshWin.guesses.length, 1, 'request IDs are scoped to an attempt');
  const forged = await replayGuess(f, token, fresh.replayId, 'invented-person');
  assert.notEqual(forged.code, 200);
});

test('study period freezes competition stats and standings while unlimited replays leave originals intact', async t => {
  const f = fixture(t);
  for (const date of ['2026-11-17', '2026-11-18', STUDY_START]) await f.publish(date);
  f.setTime('2026-11-17T18:00:00Z');
  const {token} = await f.start(); await f.guess(token);
  const identity = roster[10];
  await f.call('claim', {personId: identity.id, table: identity.table}, token);
  f.setTime('2026-11-18T18:00:00Z');
  await f.call('game', undefined, token); await f.guess(token, roster[1].id); await f.guess(token);
  await f.call('claim', {personId: identity.id, table: identity.table}, token);
  f.setTime(STUDY_NOW);
  const stats = await f.call('stats', undefined, token), board = await f.call('leaderboard', undefined, token);
  assert.equal(stats.played, 2);
  assert.equal(stats.wins, 2);
  assert.equal(stats.streak, 2);
  assert.equal(stats.maxStreak, 2);
  assert.deepEqual(stats.distribution, [1, 1, 0, 0, 0]);
  assert.deepEqual(board.entries.map(({points, played, wins, isYou}) => ({points, played, wins, isYou})), [{points: 9, played: 2, wins: 2, isYou: true}]);
  // Pre-existing or manually imported later records must not enter the completed season.
  f.db.prepare('INSERT INTO games(session,date,status,guesses,created,completed) VALUES (?,?,?,?,?,?)').run(token, STUDY_START, 'won', JSON.stringify([{personId: ANSWER.id, correct: true}]), 0, 1);
  f.db.prepare('INSERT INTO claims(date,person_id,session,points,won,attempts,created) VALUES (?,?,?,?,?,?,?)').run(STUDY_START, roster[11].id, token, 99, 1, 1, 1);
  const original = competitionSnapshot(f);
  const laterStats = await f.call('stats', undefined, token);
  assert.deepEqual(laterStats, stats);
  assert.deepEqual((await f.call('leaderboard', undefined, token)).entries, board.entries);
  for (let repeat = 0; repeat < 3; repeat++) {
    const game = await f.call('archive/start', {date: '2026-11-18', restart: true}, token);
    if (repeat === 1) {
      for (let miss = 1; miss <= 5; miss++) await replayGuess(f, token, game.replayId, roster[miss].id);
    } else await replayGuess(f, token, game.replayId, ANSWER.id);
  }
  f.setTime('2027-03-15T17:00:00Z'); f.restart();
  assert.deepEqual(await f.call('stats', undefined, token), stats, 'streaks stop aging after the study period begins');
  assert.deepEqual((await f.call('leaderboard', undefined, token)).entries, board.entries);
  assert.deepEqual(competitionSnapshot(f), original, 'replays never rewrite daily results, puzzle data, or verified claims');
});

test('replay failures roll back progress and archived puzzle content locks once opened', async t => {
  const f = fixture(t); await f.publish();
  const {token} = await f.call('session', {}); f.setTime(STUDY_NOW);
  const game = await f.call('archive/start', {date: TODAY}, token), id = game.replayId;
  const saved = competitionSnapshot(f);
  assert.equal((await f.call('admin/puzzle?date=' + TODAY, undefined, ADMIN)).puzzle.locked, true);
  assert.equal((await f.call('admin/calendar?month=2026-10', undefined, ADMIN)).days[0].locked, true);
  assert.equal((await f.publish(TODAY, {personId: roster[1].id})).code, 409);
  assert.equal((await f.publish(TODAY, {published: false})).code, 409);
  assert.equal((await f.publish('2026-10-28')).code, 409, 'replays prevent earlier epoch changes from renumbering played puzzles');
  assert.equal((await f.call('archive/start', {date: TODAY, restart: 'yes'}, token)).code, 400);
  for (const body of [
    {personId: ANSWER.id, requestId: 'valid-replay-request'},
    {replayId: id, personId: ANSWER.id, requestId: 'short'},
    {replayId: id, personId: 'not-a-classmate', requestId: 'valid-replay-request'},
  ]) assert.notEqual((await f.call('archive/guess', body, token)).code, 200);
  assert.deepEqual(await f.call('archive/game?replayId=' + id, undefined, token), game);
  const exec = f.room.sql.exec;
  f.room.sql.exec = (query, ...args) => {
    if (query.startsWith('INSERT INTO replay_requests')) throw new Error('fixture replay storage failure');
    return exec(query, ...args);
  };
  assert.equal((await replayGuess(f, token, id, ANSWER.id, 'retry-after-rollback')).code, 500);
  f.room.sql.exec = exec;
  assert.deepEqual(await f.call('archive/game?replayId=' + id, undefined, token), game);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM replay_requests').get().n, 0);
  assert.equal((await replayGuess(f, token, id, ANSWER.id, 'retry-after-rollback')).status, 'won');
  assert.deepEqual(competitionSnapshot(f), saved);
});

function addWinnerClaim(f, person, {date = TODAY, points = 5, won = 1, attempts = 1} = {}) {
  f.db.prepare('INSERT INTO claims(date,person_id,session,points,won,attempts,created) VALUES (?,?,?,?,?,?,?)').run(date, person.id, 'winner-' + person.id + date, points, won, attempts, 1);
}
function winnerCompetitionSnapshot(f) {
  const snapshot = competitionSnapshot(f);
  snapshot.settings = snapshot.settings.filter(row => row.key !== 'winner_portrait');
  return snapshot;
}

test('winner portrait setup is private, validates its selection, and preserves all puzzle and score data', async t => {
  const f = fixture(t); await f.publish(); addWinnerClaim(f, ANSWER);
  const original = winnerCompetitionSnapshot(f);
  assert.equal((await f.call('admin/winner')).code, 401);
  assert.equal((await f.call('admin/winner', {personId: ANSWER.id, photoId: PHOTO.id, image: JPEG})).code, 401);
  assert.equal((await f.raw('/api/admin/winner/image')).status, 401);
  const initial = await f.call('admin/winner', undefined, ADMIN);
  assert.equal(initial.selection, null);
  assert.equal(initial.starts, STUDY_START);
  assert.equal(initial.leader.personId, ANSWER.id);
  for (const extra of [
    {personId: 'unknown'}, {photoId: 'unknown'}, {image: 'data:image/png;base64,AAAA'},
    {image: 'not an image'}, {clear: false},
  ]) assert.equal((await f.call('admin/winner', {personId: ANSWER.id, photoId: PHOTO.id, image: JPEG, ...extra}, ADMIN)).code, 400);
  assert.equal((await f.call('admin/winner', {personId: ANSWER.id, photoId: PHOTO.id, image: 'x'.repeat(1010001)}, ADMIN)).code, 413);
  assert.equal((await f.call('admin/winner', undefined, ADMIN)).selection, null);
  // A normal resized photo can exceed the API's default 4 KB JSON body limit.
  const image = 'data:image/jpeg;base64,' + Buffer.from([255, 216, ...Array(6000).fill(0), 255, 217]).toString('base64');
  const saved = await f.call('admin/winner', {personId: ANSWER.id, photoId: PHOTO.id, image}, ADMIN);
  assert.equal(saved.code, 200);
  assert.deepEqual(Object.keys(saved.selection).sort(), ['image', 'name', 'personId', 'photoId', 'updated']);
  assert.equal(saved.selection.name, ANSWER.name);
  assert.equal(saved.selection.photoId, PHOTO.id);
  assert.equal(saved.selection.image, '/api/admin/winner/image');
  assert.equal(JSON.stringify(saved).includes('jpeg'), false);
  const preview = await f.raw(saved.selection.image, undefined, ADMIN);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(preview.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(preview.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), Buffer.from(image.split(',')[1], 'base64'));
  f.restart();
  assert.deepEqual(await f.call('admin/winner', undefined, ADMIN), saved);
  assert.deepEqual(winnerCompetitionSnapshot(f), original);
});

test('the winner photo opens only at the Central cutoff and public metadata follows the actual ranked leader', async t => {
  const f = fixture(t); addWinnerClaim(f, ANSWER, {points: 5, won: 1, attempts: 1});
  addWinnerClaim(f, roster[1], {points: 5, won: 1, attempts: 2});
  addWinnerClaim(f, roster[2], {date: STUDY_START, points: 99});
  await f.call('admin/winner', {personId: ANSWER.id, photoId: PHOTO.id, image: JPEG}, ADMIN);
  const selection = f.room.winnerSelection();
  const imageUrl = `/api/winner/portrait?person=${ANSWER.id}&version=${selection.revision}`;
  f.setTime('2026-11-19T05:59:59Z');
  assert.equal((await f.call('leaderboard')).winner, null);
  assert.equal((await f.raw(imageUrl)).status, 404);
  f.setTime(STUDY_NOW);
  const board = await f.call('leaderboard');
  assert.equal(board.entries[0].personId, ANSWER.id, 'the existing points/wins/guesses tie-breaker selects the winner');
  assert.deepEqual(board.winner, {personId: ANSWER.id, name: ANSWER.name, points: 5, image: imageUrl});
  assert.equal('photoId' in board.winner, false);
  const publicPhoto = await f.raw(board.winner.image);
  assert.equal(publicPhoto.status, 200);
  assert.equal(publicPhoto.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await publicPhoto.arrayBuffer()), Buffer.from(JPEG.split(',')[1], 'base64'));
  for (const url of ['/api/winner/portrait', `/api/winner/portrait?person=${ANSWER.id}`, `/api/winner/portrait?version=${selection.revision}`, `/api/winner/portrait?person=${roster[1].id}&version=${selection.revision}`, `/api/winner/portrait?person=${ANSWER.id}&version=wrong`]) assert.equal((await f.raw(url)).status, 404);
  assert.equal((await f.raw('/_portraits/' + PHOTO.path.split('/').at(-1))).status, 401, 'selecting one snapshot does not make original portraits public');
});

test('a changed leader hides a mismatched saved portrait and replacing it invalidates stale image URLs', async t => {
  const f = fixture(t); addWinnerClaim(f, ANSWER); addWinnerClaim(f, roster[1], {points: 4});
  await f.call('admin/winner', {personId: ANSWER.id, photoId: PHOTO.id, image: JPEG}, ADMIN);
  f.setTime(STUDY_NOW);
  const originalImage = (await f.call('leaderboard')).winner.image;
  f.db.prepare('UPDATE claims SET points=6 WHERE person_id=?').run(roster[1].id);
  const changed = await f.call('leaderboard');
  assert.deepEqual(changed.winner, {personId: roster[1].id, name: roster[1].name, points: 6, image: null});
  assert.equal((await f.raw(originalImage)).status, 404);
  assert.equal((await f.call('admin/winner', undefined, ADMIN)).selection.personId, ANSWER.id, 'the owner can still review the previous selection');
  assert.equal((await f.raw('/api/admin/winner/image', undefined, ADMIN)).status, 200);
  const original = winnerCompetitionSnapshot(f);
  const saved = await f.call('admin/winner', {personId: roster[1].id, photoId: PHOTO.id, image: JPEG}, ADMIN);
  assert.equal(saved.selection.personId, roster[1].id);
  const replacement = (await f.call('leaderboard')).winner.image;
  assert.notEqual(replacement, originalImage);
  assert.equal((await f.raw(replacement)).status, 200);
  assert.equal((await f.raw(originalImage)).status, 404);
  // Clear and re-save at the same clock instant must not resurrect an old image URL.
  await f.call('admin/winner', {clear: true}, ADMIN);
  assert.equal((await f.call('leaderboard')).winner.image, null);
  assert.equal((await f.raw(replacement)).status, 404);
  assert.equal((await f.raw('/api/admin/winner/image', undefined, ADMIN)).status, 404);
  await f.call('admin/winner', {personId: roster[1].id, photoId: PHOTO.id, image: JPEG}, ADMIN);
  const restored = (await f.call('leaderboard')).winner.image;
  assert.notEqual(restored, replacement);
  assert.equal((await f.raw(restored)).status, 200);
  assert.equal((await f.raw(replacement)).status, 404);
  await f.call('admin/winner', {personId: roster[1].id, photoId: PHOTO.id, image: JPEG}, ADMIN);
  const resaved = (await f.call('leaderboard')).winner.image;
  assert.notEqual(resaved, restored, 'two saves within a millisecond also get unique revisions');
  assert.equal((await f.raw(restored)).status, 404);
  assert.deepEqual(winnerCompetitionSnapshot(f), original);
});

test('empty standings never publish a selected winner photo and save failures preserve the previous choice', async t => {
  const f = fixture(t);
  const first = await f.call('admin/winner', {personId: ANSWER.id, photoId: PHOTO.id, image: JPEG}, ADMIN);
  const revision = f.room.winnerSelection().revision;
  f.setTime(STUDY_NOW);
  assert.equal((await f.call('leaderboard')).winner, null);
  assert.equal((await f.raw(`/api/winner/portrait?person=${ANSWER.id}&version=${revision}`)).status, 404);
  const exec = f.room.sql.exec;
  f.room.sql.exec = (query, ...args) => {
    if (query.startsWith("INSERT INTO settings(key,value) VALUES ('winner_portrait'")) throw new Error('fixture winner storage failure');
    return exec(query, ...args);
  };
  assert.equal((await f.call('admin/winner', {personId: roster[1].id, photoId: PHOTO.id, image: JPEG}, ADMIN)).code, 500);
  f.room.sql.exec = exec;
  assert.deepEqual(await f.call('admin/winner', undefined, ADMIN), first);
  assert.equal(f.room.winnerSelection().revision, revision);
});
