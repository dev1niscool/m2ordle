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
function puzzle(date = TODAY, extra = {}) {
  return {date, personId: ANSWER.id, photoId: PHOTO.id, crops: [.12, .25, .45, .7, 1].map(size => ({x: 0, y: 0, size})), images: Array(5).fill(JPEG), reveal: JPEG, published: true, ...extra};
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
  let room;
  function restart() { room = new M2ordle(ctx, config); room.now = () => now; }
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
  return {db, ctx, config, raw, call, publish, start, guess, restart, setTime: value => {now = Date.parse(value);}, get room() {return room;}};
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
  assert.deepEqual(copy.puzzle, {date: '2026-10-30', personId: ANSWER.id, photoId: PHOTO.id, crops: puzzle().crops, published: false, locked: false});
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
