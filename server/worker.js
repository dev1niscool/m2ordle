import roster from './roster.json' with {type: 'json'};
import photos from './photos.json' with {type: 'json'};
import {MAX_GUESSES, centralDate, nextCentralMidnight, validDate, dayDistance, score, publicGuesses, validateCrops, validateJpeg, calculateStats} from './core.js';

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const bearer = request => request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1] || '';
const ipOf = request => request.headers.get('CF-Connecting-IP') || 'local';
const photoPaths = new Set(photos.flatMap(group => group.photos.map(photo => photo.path)));

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
    if (origin && origin !== url.origin && !allowed.includes(origin)) return json({error: 'This website is not allowed to access M2ordle.'}, 403);
    const cors = {'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400'};
    if (origin) cors['Access-Control-Allow-Origin'] = origin;
    const withCors = response => {
      const result = new Response(response.body, response);
      for (const [key, value] of Object.entries(cors)) result.headers.set(key, value);
      return result;
    };
    if (request.method === 'OPTIONS') return withCors(new Response(null, {status: 204}));
    let path = url.pathname;
    try { for (let i = 0; i < 3; i++) path = decodeURIComponent(path); } catch { return withCors(json({error: 'Invalid URL.'}, 400)); }
    const protectedPhoto = path.split('/').some(part => part.toLowerCase() === '_portraits');
    try {
      if (protectedPhoto || path.startsWith('/api/')) {
        const object = env.M2ORDLE.get(env.M2ORDLE.idFromName('m2ordle-class-of-2029-v1'));
        if (protectedPhoto) {
          if (request.method !== 'GET') return withCors(json({error: 'Not found.'}, 404));
          const authUrl = new URL('/api/admin/auth', url);
          const auth = await object.fetch(new Request(authUrl, {headers: request.headers}));
          if (!auth.ok) return withCors(auth);
          if (!photoPaths.has(path)) return withCors(json({error: 'Portrait not found.'}, 404));
          const canonical = new URL(path, url);
          const asset = await env.ASSETS.fetch(new Request(canonical, {headers: request.headers}));
          const result = new Response(asset.body, asset);
          result.headers.set('Cache-Control', 'private, no-store');
          result.headers.set('X-Content-Type-Options', 'nosniff');
          return withCors(result);
        }
        return withCors(await object.fetch(request));
      }
      return env.ASSETS.fetch(request);
    } catch { return withCors(json({error: 'The class server is taking a break. Please try again.'}, 503)); }
  }
};

export class M2ordle {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.people = new Map(roster.map(person => [person.id, person]));
    this.photos = new Map(photos.flatMap(group => group.photos.map(photo => [photo.id, photo])));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS puzzles (date TEXT PRIMARY KEY, person_id TEXT NOT NULL, photo_id TEXT NOT NULL, crops TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS images (date TEXT NOT NULL, stage TEXT NOT NULL, jpeg TEXT NOT NULL, PRIMARY KEY (date, stage));
      CREATE TABLE IF NOT EXISTS games (session TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'playing', guesses TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, completed INTEGER, PRIMARY KEY (session, date));
      CREATE TABLE IF NOT EXISTS guess_requests (session TEXT NOT NULL, request_id TEXT NOT NULL, date TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (session, request_id));
      CREATE TABLE IF NOT EXISTS claims (date TEXT NOT NULL, person_id TEXT NOT NULL, session TEXT NOT NULL, points INTEGER NOT NULL, won INTEGER NOT NULL, attempts INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (date, person_id), UNIQUE (date, session));
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS games_date ON games(date, status);
      CREATE INDEX IF NOT EXISTS claims_person ON claims(person_id);
    `);
  }
  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0]; }
  all(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  atomic(fn) { return this.ctx.storage.transactionSync(fn); }
  now() { return Date.now(); }
  checkLimit(key, maximum, duration, consume = true) {
    const now = this.now(), existing = this.one('SELECT count,until FROM limits WHERE key=?', key);
    if (existing && existing.until > now && existing.count >= maximum) fail('Too many attempts. Please try again in 15 minutes.', 429);
    if (consume) {
      const count = existing && existing.until > now ? existing.count + 1 : 1;
      const until = existing && existing.until > now ? existing.until : now + duration;
      this.sql.exec('INSERT INTO limits(key,count,until) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,until=excluded.until', key, count, until);
    }
  }
  async admin(request) {
    const secret = this.env.ADMIN_PASSWORD;
    if (!secret || secret.length < 20) fail('Admin access is not configured.', 503);
    const key = 'admin:' + ipOf(request);
    this.checkLimit(key, 8, 15 * 60000, false);
    const provided = bearer(request);
    const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    const [a, b] = await Promise.all([digest(secret), digest(provided.length <= 512 ? provided : '')]);
    const aa = new Uint8Array(a), bb = new Uint8Array(b);
    let difference = 0;
    for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
    if (difference) {
      this.checkLimit(key, 8, 15 * 60000);
      fail('Incorrect admin password.', 401);
    }
    this.sql.exec('DELETE FROM limits WHERE key=?', key);
  }
  session(request) {
    const token = bearer(request), row = token && this.one('SELECT * FROM sessions WHERE token=?', token);
    if (!row) fail('Press Play to start a session.', 401);
    return row;
  }
  puzzle(date) { return this.one('SELECT * FROM puzzles WHERE date=? AND published=1', date); }
  gameRow(token, date, create = false) {
    if (create) this.sql.exec('INSERT OR IGNORE INTO games(session,date,created) VALUES (?,?,?)', token, date, this.now());
    return this.one('SELECT * FROM games WHERE session=? AND date=?', token, date);
  }
  state(token, date = centralDate(this.now()), create = false) {
    const nextReset = nextCentralMidnight(this.now()), puzzle = this.puzzle(date);
    if (!puzzle) return {available: false, date, nextReset, message: "Check again, or contact Devin to update today's M2ordle."};
    const row = this.gameRow(token, date, create);
    if (!row) fail('Start today’s puzzle first.', 409);
    const guesses = JSON.parse(row.guesses), completed = row.status !== 'playing';
    const claim = this.one('SELECT person_id FROM claims WHERE session=? AND date=?', token, date);
    const epoch = this.one("SELECT value FROM settings WHERE key='epoch'").value;
    const stage = completed ? 'reveal' : String(guesses.length);
    return {
      available: true, date, number: dayDistance(epoch, date) + 1, nextReset, maxGuesses: MAX_GUESSES,
      status: row.status, guesses: publicGuesses(guesses, this.people), image: `/api/image?date=${date}&stage=${stage}`,
      ...(completed ? {answer: {id: puzzle.person_id, name: this.people.get(puzzle.person_id).name}} : {}),
      points: score(row.status, guesses.length), ...(claim ? {claimed: {name: this.people.get(claim.person_id).name}} : {}),
      shareUrl: this.env.SHARE_URL || 'https://dev1niscool.github.io/m2ordle'
    };
  }
  guess(token, body) {
    if (!this.people.has(body.personId)) fail('Choose a classmate from the list.');
    if (typeof body.requestId !== 'string' || !/^[\w-]{8,100}$/.test(body.requestId)) fail('A valid request ID is required.');
    return this.atomic(() => {
      const previous = this.one('SELECT * FROM guess_requests WHERE session=? AND request_id=?', token, body.requestId);
      if (previous) {
        if (previous.person_id !== body.personId) fail('This guess request was already used.', 409);
        return this.state(token, previous.date);
      }
      const date = centralDate(this.now()), puzzle = this.puzzle(date);
      if (body.date !== undefined && body.date !== date) fail('A new M2ordle has started. Refresh to play today’s puzzle.', 409);
      if (!puzzle) fail('Today’s M2ordle is not ready yet.', 409);
      const game = this.gameRow(token, date);
      if (!game) fail('A new M2ordle has started. Refresh to play today’s puzzle.', 409);
      if (game.status !== 'playing') fail('You have already completed today’s M2ordle.', 409);
      const guesses = JSON.parse(game.guesses);
      if (guesses.some(guess => guess.personId === body.personId)) fail('You have already guessed that classmate.', 409);
      const correct = body.personId === puzzle.person_id;
      guesses.push({personId: body.personId, correct});
      const status = correct ? 'won' : guesses.length === MAX_GUESSES ? 'lost' : 'playing';
      this.sql.exec('UPDATE games SET guesses=?,status=?,completed=? WHERE session=? AND date=?', JSON.stringify(guesses), status, status === 'playing' ? null : this.now(), token, date);
      this.sql.exec('INSERT INTO guess_requests(session,request_id,date,person_id) VALUES (?,?,?,?)', token, body.requestId, date, body.personId);
      return this.state(token, date);
    });
  }
  claim(token, body, request) {
    const person = this.people.get(body.personId);
    if (!person) fail('Choose your name from the list.');
    return this.atomic(() => {
      const date = centralDate(this.now()), game = this.gameRow(token, date);
      if (body.date !== undefined && body.date !== date) fail('A new M2ordle has started. Refresh to play today’s puzzle.', 409);
      if (!game || game.status === 'playing') fail('Finish today’s M2ordle before joining the leaderboard.', 409);
      const prior = this.one('SELECT * FROM claims WHERE session=? AND date=?', token, date);
      if (prior) {
        if (prior.person_id !== person.id) fail('This result has already been added under another name.', 409);
        return this.state(token, date);
      }
      const sessionKey = 'table-session:' + token, ipKey = 'table-ip:' + ipOf(request);
      this.checkLimit(sessionKey, 5, 15 * 60000, false);
      this.checkLimit(ipKey, 12, 15 * 60000, false);
      if (!/^\d{1,3}$/.test(String(body.table ?? '').trim()) || Number(body.table) !== Number(person.table)) {
        this.checkLimit(sessionKey, 5, 15 * 60000);
        this.checkLimit(ipKey, 12, 15 * 60000);
        // Return normally so the persistent failed-attempt counts commit.
        return {claimError: 'That table number does not match. Please try again.', statusCode: 401};
      }
      const existing = this.one('SELECT person_id FROM claims WHERE date=? AND person_id=?', date, person.id);
      if (existing) fail('A result for this name has already been added today.', 409);
      const attempts = JSON.parse(game.guesses).length;
      this.sql.exec('INSERT INTO claims(date,person_id,session,points,won,attempts,created) VALUES (?,?,?,?,?,?,?)', date, person.id, token, score(game.status, attempts), Number(game.status === 'won'), game.status === 'won' ? attempts : MAX_GUESSES + 1, this.now());
      return this.state(token, date);
    });
  }
  leaderboard() {
    const entries = this.all('SELECT person_id AS personId,SUM(points) AS points,SUM(won) AS wins,COUNT(*) AS played,AVG(attempts) AS averageGuesses FROM claims GROUP BY person_id')
      .map(row => ({...row, name: this.people.get(row.personId)?.name || 'Classmate'}))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.averageGuesses - b.averageGuesses || a.name.localeCompare(b.name));
    return {entries: entries.map((row, index) => ({rank: index + 1, ...row}))};
  }
  async body(request) {
    const maxLength = new URL(request.url).pathname === '/api/admin/puzzle' ? 6500000 : 4096;
    if (Number(request.headers.get('Content-Length')) > maxLength) fail('This request is too large.', 413);
    const reader = request.body?.getReader();
    if (!reader) fail('Please send a valid JSON request.');
    const chunks = [];
    let length = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxLength) { await reader.cancel(); fail('This request is too large.', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    const text = new TextDecoder().decode(bytes);
    let body;
    try { body = JSON.parse(text); } catch { fail('Please send a valid JSON request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Please send a valid request.');
    return body;
  }
  savePuzzle(body) {
    if (!validDate(body.date)) fail('Choose a valid calendar date.');
    if (!this.people.has(body.personId)) fail('Choose a classmate from the roster.');
    const photo = this.photos.get(body.photoId);
    if (!photo) fail('Choose an available portrait.');
    if (typeof body.published !== 'boolean') fail('Choose whether this puzzle is published.');
    let crops, images, reveal;
    try {
      crops = validateCrops(body.crops, photo);
      if (!Array.isArray(body.images) || body.images.length !== MAX_GUESSES) throw new Error('Create all five crop images.');
      images = body.images.map(validateJpeg);
      reveal = validateJpeg(body.reveal);
    } catch (error) { fail(error.message); }
    return this.atomic(() => {
      if (this.one('SELECT 1 AS found FROM games WHERE date=? LIMIT 1', body.date)) fail('This puzzle has already been played and is locked to keep results fair.', 409);
      const epoch = this.one("SELECT value FROM settings WHERE key='epoch'");
      if (body.published && (!epoch || body.date < epoch.value)) {
        if (epoch && this.one('SELECT 1 AS found FROM games LIMIT 1')) fail('Choose a date on or after the first M2ordle.', 409);
        this.sql.exec("INSERT INTO settings(key,value) VALUES ('epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", body.date);
      }
      this.sql.exec('INSERT INTO puzzles(date,person_id,photo_id,crops,published,updated) VALUES (?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET person_id=excluded.person_id,photo_id=excluded.photo_id,crops=excluded.crops,published=excluded.published,updated=excluded.updated', body.date, body.personId, body.photoId, JSON.stringify(crops), Number(body.published), this.now());
      this.sql.exec('DELETE FROM images WHERE date=?', body.date);
      for (let i = 0; i < MAX_GUESSES; i++) this.sql.exec('INSERT INTO images(date,stage,jpeg) VALUES (?,?,?)', body.date, String(i), images[i]);
      this.sql.exec('INSERT INTO images(date,stage,jpeg) VALUES (?,?,?)', body.date, 'reveal', reveal);
      return {saved: true, puzzle: {date: body.date, personId: body.personId, photoId: body.photoId, crops, published: body.published}};
    });
  }
  image(token, url) {
    const date = url.searchParams.get('date'), stage = url.searchParams.get('stage');
    if (!validDate(date)) fail('Invalid puzzle date.');
    const game = this.gameRow(token, date);
    if (!game) fail('Start this puzzle before viewing its image.', 403);
    const count = JSON.parse(game.guesses).length, completed = game.status !== 'playing';
    const allowed = stage === 'reveal' ? completed : /^[0-4]$/.test(stage || '') && Number(stage) <= (completed ? count - 1 : count);
    if (!allowed) fail('This image has not been unlocked yet.', 403);
    const row = this.one('SELECT jpeg FROM images WHERE date=? AND stage=?', date, stage);
    if (!row) fail('This image is unavailable.', 404);
    const raw = atob(row.jpeg), bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    return new Response(bytes, {headers: {'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}});
  }
  async fetch(request) {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (path.startsWith('/api/admin/')) {
        await this.admin(request);
        if (method === 'GET' && path === '/api/admin/auth') return json({ok: true});
        if (method === 'GET' && path === '/api/admin/photos') return json({groups: photos});
        if (method === 'GET' && path === '/api/admin/calendar') {
          const month = url.searchParams.get('month');
          if (!/^\d{4}-\d{2}$/.test(month || '') || !validDate(month + '-01')) fail('Choose a valid month.');
          return json({days: this.all('SELECT date,person_id,photo_id,published FROM puzzles WHERE date LIKE ? ORDER BY date', month + '-%').map(row => ({date: row.date, personId: row.person_id, name: this.people.get(row.person_id).name, photoId: row.photo_id, published: Boolean(row.published)})), today: centralDate(this.now())});
        }
        if (method === 'GET' && path === '/api/admin/puzzle') {
          const date = url.searchParams.get('date');
          if (!validDate(date)) fail('Choose a valid date.');
          const row = this.one('SELECT * FROM puzzles WHERE date=?', date);
          return json({puzzle: row ? {date: row.date, personId: row.person_id, photoId: row.photo_id, crops: JSON.parse(row.crops), published: Boolean(row.published), locked: Boolean(this.one('SELECT 1 AS found FROM games WHERE date=? LIMIT 1', date))} : null});
        }
        if (method === 'POST' && path === '/api/admin/puzzle') return json(this.savePuzzle(await this.body(request)));
        return json({error: 'Not found.'}, 404);
      }
      if (method === 'GET' && path === '/api/health') return json({ok: true});
      if (method === 'GET' && path === '/api/roster') return json({people: roster.map(({id, name}) => ({id, name}))});
      if (method === 'GET' && path === '/api/leaderboard') return json(this.leaderboard());
      if (method === 'POST' && path === '/api/session') {
        await this.body(request);
        this.checkLimit('session:' + ipOf(request), 600, 15 * 60000);
        const token = crypto.randomUUID() + crypto.randomUUID();
        this.sql.exec('INSERT INTO sessions(token,created) VALUES (?,?)', token, this.now());
        return json({token}, 201);
      }
      const session = this.session(request);
      if (method === 'GET' && path === '/api/game') return json(this.atomic(() => this.state(session.token, centralDate(this.now()), true)));
      if (method === 'GET' && path === '/api/image') return this.image(session.token, url);
      if (method === 'GET' && path === '/api/stats') {
        const today = centralDate(this.now());
        return json(calculateStats(this.all('SELECT date,status,guesses FROM games WHERE session=?', session.token), today, this.all('SELECT status,guesses FROM games WHERE date=?', today)));
      }
      if (method === 'POST' && path === '/api/guess') return json(this.guess(session.token, await this.body(request)));
      if (method === 'POST' && path === '/api/claim') {
        const result = this.claim(session.token, await this.body(request), request);
        return result.claimError ? json({error: result.claimError}, result.statusCode) : json(result);
      }
      return json({error: 'Not found.'}, 404);
    } catch (error) { return json({error: error.status ? error.message : 'The server could not finish that request. Please try again.'}, error.status || 500); }
  }
}
