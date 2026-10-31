import { openPuzzlePreview, closePuzzlePreview } from './admin-preview.js?v=16';

const $ = id => document.getElementById(id);
const apiBase = String(window.M2ORDLE_CONFIG?.apiBase || '').replace(/\/$/, '');
const PAGE_SIZE = 12;
const IDLE_MS = 15 * 60 * 1000;
const state = {
  password: '', epoch: 0, people: [], groups: [], photos: new Map(), imageCache: new Map(),
  today: centralDate(), day: centralDate(), month: centralDate().slice(0, 7), days: new Map(),
  galleryPage: 0, galleryQuery: '', galleryEpoch: 0, group: null, photo: null, source: null,
  person: null, facts: [], stage: 0, crops: [], dirty: false, published: false, busy: false, loading: false, photoLoading: false,
  dayEpoch: 0, photoEpoch: 0, options: [], optionIndex: -1, idleTimer: null,
  calendarEpoch: 0, calendarLoading: false, calendarLoaded: false,
  overviewEpoch: 0, overviewLoading: false, overview: null, hasSaved: false, locked: false, copyDateEdited: false
};

function centralDate() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = kind => parts.find(p => p.type === kind).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function prettyDate(day) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
}
function setMessage(id, text = '', kind = 'error') {
  $(id).textContent = text;
  $(id).dataset.kind = kind;
}
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
async function api(path, options = {}) {
  const password = state.password;
  const headers = new Headers(options.headers);
  if (password) headers.set('Authorization', `Bearer ${password}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  let response;
  try { response = await fetch(apiBase + path, { ...options, headers, cache: 'no-store' }); }
  catch { throw new Error('Couldn’t reach M2ordle. Check your connection and try again.'); }
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { /* Use the fallback below. */ }
    const error = new Error(data?.error || `The request could not be completed (${response.status}).`);
    error.status = response.status;
    if (response.status === 401 && !path.endsWith('/auth') && password === state.password) lock('Your admin session has locked. Enter your password again.');
    throw error;
  }
  if (options.blob) return response.blob();
  return response.json();
}
function touchSession() {
  if (!state.password) return;
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => lock('Locked after 15 minutes of inactivity.'), IDLE_MS);
}
function lock(message = '') {
  closePuzzlePreview();
  state.password = '';
  state.epoch++;
  state.dayEpoch++;
  state.photoEpoch++;
  state.galleryEpoch++;
  state.calendarEpoch++;
  state.overviewEpoch++;
  clearTimeout(state.idleTimer);
  for (const item of state.imageCache.values()) if (item.url) URL.revokeObjectURL(item.url);
  state.imageCache.clear();
  state.source = null;
  state.photo = null;
  state.group = null;
  state.person = null;
  state.facts = [];
  state.crops = [];
  state.people = [];
  state.groups = [];
  state.photos.clear();
  state.days.clear();
  state.overview = null;
  state.overviewLoading = false;
  state.calendarLoading = false;
  state.calendarLoaded = false;
  state.hasSaved = false;
  state.locked = false;
  state.dirty = false;
  state.loading = false;
  state.photoLoading = false;
  state.busy = false;
  drag = null;
  document.querySelector('.admin-editor').inert = false;
  document.querySelector('.admin-sidebar').inert = false;
  $('admin-password').value = '';
  $('workspace').hidden = true;
  $('workspace').dataset.busy = 'false';
  $('lock-button').hidden = true;
  $('login-screen').hidden = false;
  $('portrait-gallery').replaceChildren();
  $('pose-gallery').replaceChildren();
  $('chosen-portrait-thumb').removeAttribute('src');
  $('answer-name').value = '';
  renderAnswerStatus();
  $('answer-options').replaceChildren();
  $('calendar-days').replaceChildren();
  $('upcoming-days').replaceChildren();
  $('activity-metrics').replaceChildren();
  $('activity-date').textContent = '';
  $('activity-note').textContent = '';
  $('schedule-alert').textContent = 'Loading the schedule…';
  $('overview-today').textContent = '—';
  $('overview-ready').textContent = '— / 14';
  $('overview-missing').textContent = '—';
  $('copy-date').value = '';
  for (const id of ['overview-message','copy-message']) setMessage(id);
  for (const canvas of document.querySelectorAll('#workspace canvas')) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  $('unlock-button').disabled = false;
  $('unlock-button').textContent = 'UNLOCK →';
  setMessage('login-message', message, 'info');
  $('admin-password').focus();
}
async function loadImage(path) {
  const existing = state.imageCache.get(path);
  if (existing) return existing.promise;
  const epoch = state.epoch;
  const entry = { url: null, promise: null };
  entry.promise = (async () => {
    const blob = await api(path, { blob: true });
    if (epoch !== state.epoch) throw new Error('Admin session changed.');
    const url = URL.createObjectURL(blob);
    entry.url = url;
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    try { await image.decode(); }
    catch { URL.revokeObjectURL(url); throw new Error('This portrait could not be loaded. Try another pose.'); }
    if (epoch !== state.epoch) { URL.revokeObjectURL(url); throw new Error('Admin session changed.'); }
    return { image, url };
  })().catch(error => { state.imageCache.delete(path); throw error; });
  state.imageCache.set(path, entry);
  return entry.promise;
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('unlock-button').disabled) return;
  state.password = $('admin-password').value;
  state.epoch++;
  const epoch = state.epoch;
  $('unlock-button').disabled = true;
  $('unlock-button').textContent = 'UNLOCKING…';
  setMessage('login-message');
  try {
    await api('/api/admin/auth');
    const [roster, photos] = await Promise.all([api('/api/admin/roster'), api('/api/admin/photos')]);
    if (epoch !== state.epoch) return;
    state.people = roster.people || [];
    state.groups = photos.groups || [];
    state.photos = new Map();
    for (const group of state.groups) for (const photo of group.photos) state.photos.set(photo.id, { group, photo });
    state.today = centralDate();
    state.day = state.today;
    state.month = state.today.slice(0, 7);
    state.galleryPage = 0;
    state.galleryQuery = '';
    $('portrait-search').value = '';
    $('admin-password').value = '';
    $('login-screen').hidden = true;
    $('workspace').hidden = false;
    $('lock-button').hidden = false;
    touchSession();
    await loadCalendar();
    if (epoch !== state.epoch) return;
    await selectDay(state.today, true);
  } catch (error) {
    if (epoch !== state.epoch) return;
    state.password = '';
    setMessage('login-message', error.message);
  } finally {
    if (epoch === state.epoch) {
      $('unlock-button').disabled = false;
      $('unlock-button').textContent = 'UNLOCK →';
    }
  }
});
$('lock-button').addEventListener('click', () => lock());
for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, touchSession, { passive: true });
window.addEventListener('pagehide', () => lock());
window.addEventListener('beforeunload', event => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

async function loadCalendar() {
  const month = state.month;
  const epoch = ++state.calendarEpoch;
  const session = state.epoch;
  state.calendarLoading = true;
  state.calendarLoaded = false;
  $('export-month').disabled = true;
  $('calendar-month').value = month;
  state.days = new Map();
  renderCalendar();
  setMessage('calendar-message');
  try {
    const response = await api(`/api/admin/calendar?month=${encodeURIComponent(month)}`);
    if (epoch !== state.calendarEpoch || session !== state.epoch || month !== state.month || !state.password) return;
    state.days = new Map((response.days || []).map(day => [day.date, day]));
    if (response.today) state.today = response.today;
    state.calendarLoaded = true;
    renderCalendar();
  } catch (error) { if (epoch === state.calendarEpoch && session === state.epoch) setMessage('calendar-message', error.message); }
  finally { if (epoch === state.calendarEpoch && session === state.epoch) { state.calendarLoading = false; updateSaveButtons(); } }
}
function renderCalendar() {
  const grid = $('calendar-days');
  grid.replaceChildren();
  const [year, month] = state.month.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let i = 0; i < start; i++) grid.append(node('span', 'calendar-blank'));
  for (let number = 1; number <= count; number++) {
    const date = `${state.month}-${String(number).padStart(2, '0')}`;
    const puzzle = state.days.get(date);
    const button = node('button', 'calendar-day', number);
    button.type = 'button';
    if (date === state.day) { button.classList.add('selected'); button.setAttribute('aria-pressed', 'true'); }
    if (date === state.today) { button.classList.add('today'); button.setAttribute('aria-current', 'date'); }
    if (date < state.today) button.classList.add('past');
    if (puzzle) button.classList.add(puzzle.published ? 'scheduled' : 'draft');
    if (puzzle?.locked) button.classList.add('locked');
    button.setAttribute('aria-label', `${prettyDate(date)}${date === state.today ? ', today' : ''}${puzzle ? `, ${puzzle.published ? 'published' : 'draft'}, ${puzzle.name || 'puzzle'}${puzzle.locked ? ', played and locked' : ''}` : ', not set'}`);
    button.addEventListener('click', () => selectDay(date));
    grid.append(button);
  }
}
function moveMonth(amount) {
  if (state.busy) return;
  const [year, month] = state.month.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  const next = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}$/.test(next)) return;
  state.month = next;
  loadCalendar();
}
$('previous-month').addEventListener('click', () => moveMonth(-1));
$('next-month').addEventListener('click', () => moveMonth(1));
$('calendar-month').addEventListener('change', event => {
  if (state.busy) return;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) return;
  state.month = event.target.value;
  loadCalendar();
});
$('today-button').addEventListener('click', () => selectDay(state.today));

function addDays(day, amount) {
  return new Date(Date.parse(day + 'T12:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
}
function suggestedCopyDate(source) {
  const start = source < state.today ? state.today : addDays(source, 1);
  for (let offset = 0; offset < 32; offset++) {
    const day = addDays(start, offset);
    if (!state.days.has(day) && !state.overview?.upcoming.some(item => item.date === day && item.name !== null)) return day;
  }
  return start;
}
function shortDate(day) {
  return new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric'}).format(new Date(day + 'T12:00:00Z'));
}
async function loadOverview(day = state.day) {
  const epoch = ++state.overviewEpoch;
  const session = state.epoch;
  state.overviewLoading = true;
  $('activity-date').textContent = prettyDate(day);
  $('activity-metrics').replaceChildren();
  $('activity-note').textContent = 'Loading activity…';
  setMessage('overview-message');
  updateSaveButtons();
  try {
    const overview = await api(`/api/admin/overview?date=${encodeURIComponent(day)}`);
    if (epoch !== state.overviewEpoch || session !== state.epoch || day !== state.day || !state.password) return;
    state.overview = overview;
    state.today = overview.today;
    $('copy-date').min = state.today;
    if (!state.copyDateEdited) $('copy-date').value = suggestedCopyDate(state.day);
    renderOverview();
  } catch (error) {
    if (epoch !== state.overviewEpoch || session !== state.epoch || day !== state.day) return;
    state.overview = null;
    $('overview-today').textContent = '—';
    $('overview-ready').textContent = '— / 14';
    $('overview-missing').textContent = '—';
    $('upcoming-days').replaceChildren();
    $('schedule-alert').textContent = 'The latest schedule could not be loaded.';
    $('activity-note').textContent = 'Activity is temporarily unavailable. Try Refresh.';
    setMessage('overview-message', error.message);
  } finally {
    if (epoch === state.overviewEpoch && session === state.epoch) { state.overviewLoading = false; updateSaveButtons(); }
  }
}
function renderOverview() {
  const {upcoming, activity} = state.overview;
  const ready = upcoming.filter(day => day.published).length;
  const today = upcoming.find(day => day.date === state.today);
  const gap = upcoming.find(day => !day.published);
  $('overview-today').textContent = today?.published ? 'Live' : today?.name ? 'Draft only' : 'Not set';
  $('overview-today').dataset.ready = String(Boolean(today?.published));
  $('overview-ready').textContent = `${ready} / ${upcoming.length}`;
  $('overview-missing').textContent = upcoming.length - ready;
  $('schedule-alert').textContent = !today?.published ? 'Today needs a published puzzle. Players are seeing the check-back message.' : gap ? `${shortDate(gap.date)} is the next day that needs a published puzzle.` : 'You’re ready for the next two weeks.';
  $('schedule-alert').dataset.ready = String(!gap);
  const list = $('upcoming-days');
  list.replaceChildren();
  for (const day of upcoming) {
    const button = node('button', 'upcoming-day');
    button.type = 'button';
    button.dataset.state = day.published ? 'published' : day.name ? 'draft' : 'empty';
    button.setAttribute('aria-label', `${prettyDate(day.date)}, ${day.published ? 'published' : day.name ? 'draft' : 'not set'}${day.name ? ', ' + day.name : ''}${day.locked ? ', played and locked' : ''}`);
    button.append(node('strong', '', day.date === state.today ? 'Today' : shortDate(day.date)), node('span', 'upcoming-name', day.name || 'Choose a classmate'), node('span', 'upcoming-status', day.locked ? 'PLAYED · LOCKED' : day.published ? 'READY' : day.name ? 'DRAFT' : 'NOT SET'));
    button.addEventListener('click', async () => { await selectDay(day.date); if (state.day === day.date) $('selected-date-title').scrollIntoView({block: 'start', behavior: 'smooth'}); });
    list.append(button);
  }
  const metrics = $('activity-metrics');
  metrics.replaceChildren();
  for (const [value, label] of [[activity.started, 'Started'],[activity.completed, 'Completed'],[`${activity.winRate}%`, 'Win rate'],[activity.averageGuesses === null ? '—' : Number(activity.averageGuesses).toFixed(1), 'Avg. winning guesses'],[activity.claimed, 'Added to leaderboard'],[activity.failed, 'Unsolved']]) {
    const metric = node('div');metric.append(node('strong', '', value), node('span', '', label));metrics.append(metric);
  }
  $('activity-note').textContent = 'Activity counts browser games. Win rate uses completed games; average guesses uses wins.';
}
$('refresh-dashboard').addEventListener('click', async () => {
  if (state.busy || state.loading || state.overviewLoading) return;
  const day = state.day, epoch = state.dayEpoch, session = state.epoch;
  await Promise.all([loadCalendar(), loadOverview(day)]);
  if (epoch !== state.dayEpoch || session !== state.epoch || !state.password) return;
  try {
    const {puzzle} = await api(`/api/admin/puzzle?date=${encodeURIComponent(day)}`);
    if (epoch !== state.dayEpoch || session !== state.epoch) return;
    if (puzzle?.locked) { state.locked = true; updateStatus(); updateSaveButtons(); }
  } catch (error) { if (epoch === state.dayEpoch && session === state.epoch) setMessage('overview-message', error.message); }
});
$('next-gap').addEventListener('click', async () => {
  const gap = state.overview?.upcoming.find(day => !day.published);
  if (gap) { await selectDay(gap.date); if (state.day === gap.date) $('selected-date-title').scrollIntoView({block: 'start', behavior: 'smooth'}); }
});
$('preview-puzzle').addEventListener('click', () => {
  if ($('preview-puzzle').disabled) return;
  openPuzzlePreview({source: state.source, crops: state.crops, facts: state.facts, name: state.person?.name || 'Classmate', date: state.day});
});
$('copy-date').addEventListener('input', () => { state.copyDateEdited = true; setMessage('copy-message'); updateSaveButtons(); });
$('copy-puzzle-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('copy-puzzle').disabled) return;
  const sourceDate = state.day, targetDate = $('copy-date').value;
  const session = state.epoch, epoch = state.dayEpoch;
  state.busy = true;
  document.querySelector('.admin-editor').inert = true;
  document.querySelector('.admin-sidebar').inert = true;
  updateSaveButtons();
  setMessage('copy-message', 'Copying the saved puzzle…', 'info');
  try {
    await api('/api/admin/copy', {method: 'POST', body: JSON.stringify({sourceDate, targetDate})});
    if (session !== state.epoch || epoch !== state.dayEpoch || !state.password) return;
    state.month = targetDate.slice(0, 7);
    await loadCalendar();
    if (session !== state.epoch || epoch !== state.dayEpoch) return;
    state.busy = false;
    await selectDay(targetDate, true);
    if (session !== state.epoch || state.day !== targetDate) return;
    setMessage('editor-message', `Copied from ${prettyDate(sourceDate)}. This is a draft; review the clues and publish when ready.`, 'success');
    $('selected-date-title').scrollIntoView({block: 'start', behavior: 'smooth'});
  } catch (error) {
    if (session === state.epoch && epoch === state.dayEpoch) setMessage('copy-message', error.message);
  } finally {
    if (session === state.epoch) {
      state.busy = false;
      document.querySelector('.admin-editor').inert = state.loading;
      document.querySelector('.admin-sidebar').inert = false;
      updateSaveButtons();
    }
  }
});
$('export-month').addEventListener('click', () => {
  if (!state.calendarLoaded || state.calendarLoading || state.busy) return;
  const [year, month] = state.month.split('-').map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = [['Date (Central)', 'Status', 'Classmate', 'Portrait ID', 'Played / locked']];
  for (let number = 1; number <= count; number++) {
    const date = `${state.month}-${String(number).padStart(2, '0')}`;
    const puzzle = state.days.get(date);
    rows.push([date, puzzle ? puzzle.published ? 'Published' : 'Draft' : 'Not set', puzzle?.name || '', puzzle?.photoId || '', puzzle?.locked ? 'Yes' : 'No']);
  }
  const cell = value => { const text = String(value); return '"' + (/^[\s]*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; };
  const csv = '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = node('a');link.href = url;link.download = `m2ordle-schedule-${state.month}.csv`;document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url), 1000);
  setMessage('calendar-message', 'Month CSV prepared, including unpublished and empty days.', 'success');
});

async function selectDay(day, initial = false) {
  if (state.busy) return;
  if (!initial && state.dirty && !window.confirm('You have unsaved edits. Discard them and open this day?')) return;
  closePuzzlePreview();
  const epoch = ++state.dayEpoch;
  ++state.photoEpoch;
  state.day = day;
  state.dirty = false;
  state.published = false;
  state.hasSaved = false;
  state.locked = false;
  state.loading = true;
  state.photoLoading = false;
  state.group = null;
  state.photo = null;
  state.source = null;
  state.crops = [];
  state.person = null;
  state.facts = [];
  state.stage = 0;
  drag = null;
  if (state.month !== day.slice(0, 7)) { state.month = day.slice(0, 7); void loadCalendar(); }
  $('copy-date').min = state.today;
  $('copy-date').value = suggestedCopyDate(day);
  state.copyDateEdited = false;
  setMessage('copy-message');
  $('selected-date-title').textContent = prettyDate(day);
  $('answer-name').value = '';
  closeOptions();
  renderAnswerStatus();
  resetPhotoUI();
  renderCalendar();
  updateStatus();
  updateSaveButtons();
  void loadOverview(day);
  document.querySelector('.admin-editor').dataset.loading = 'true';
  document.querySelector('.admin-editor').inert = true;
  setMessage('editor-message', 'Loading this day…', 'info');
  try {
    const { puzzle } = await api(`/api/admin/puzzle?date=${encodeURIComponent(day)}`);
    if (epoch !== state.dayEpoch || !state.password) return;
    if (puzzle) {
      state.published = Boolean(puzzle.published);
      state.hasSaved = true;
      state.locked = Boolean(puzzle.locked);
      state.person = state.people.find(person => person.id === puzzle.personId) || null;
      state.facts = validFacts(puzzle.facts);
      $('answer-name').value = state.person ? answerLabel(state.person) : '';
      renderAnswerStatus();
      const selected = state.photos.get(puzzle.photoId);
      if (selected) await choosePhoto(selected.group, selected.photo, { crops: puzzle.crops, saved: true });
      else setMessage('editor-message', 'The saved portrait is unavailable. Choose a replacement before saving.');
    }
    if (epoch !== state.dayEpoch) return;
    state.dirty = false;
    updateStatus();
    if (!puzzle || state.source) setMessage('editor-message');
  } catch (error) { if (epoch === state.dayEpoch) setMessage('editor-message', error.message); }
  finally {
    if (epoch === state.dayEpoch) {
      state.loading = false;
      document.querySelector('.admin-editor').dataset.loading = 'false';
      document.querySelector('.admin-editor').inert = false;
      updateSaveButtons();
    }
  }
}
function resetPhotoUI() {
  $('chosen-portrait-summary').hidden = true;
  $('change-portrait').hidden = true;
  $('gallery-section').hidden = false;
  $('pose-section').hidden = true;
  $('crop-empty').hidden = false;
  $('crop-workspace').hidden = true;
  $('chosen-portrait-thumb').removeAttribute('src');
  renderGallery();
}
function updateStatus() {
  const status = $('puzzle-status');
  $('save-note').classList.remove('save-error');
  status.textContent = state.locked ? 'PLAYED · LOCKED' : state.dirty ? 'UNSAVED' : state.published ? 'PUBLISHED' : state.hasSaved ? 'DRAFT' : 'NOT SET';
  status.dataset.state = state.locked ? 'locked' : state.dirty ? 'unsaved' : state.published ? 'published' : state.hasSaved ? 'draft' : 'empty';
  $('save-note').textContent = state.locked ? 'Played puzzles stay locked to keep scores fair.' : state.dirty ? 'You have unsaved changes.' : state.published ? 'This day is published.' : 'Ready when you are.';
  $('locked-note').hidden = !state.locked;
  $('publish-puzzle').textContent = state.published ? 'UPDATE DAY ↗' : 'PUBLISH DAY ↗';
}
function markDirty() {
  if (state.locked) return;
  state.dirty = true;
  updateStatus();
  updateSaveButtons();
}
function updateSaveButtons() {
  const ready = Boolean(state.source && state.photo && state.person && state.crops.length === cropCount() && !state.locked && !state.busy && !state.loading && !state.photoLoading);
  $('save-draft').disabled = !ready;
  $('publish-puzzle').disabled = !ready;
  $('save-draft').textContent = state.busy ? 'Saving…' : 'Save draft';
  $('preview-puzzle').disabled = !state.source || (state.facts.length > 0 && !state.person) || state.crops.length !== cropCount() || state.busy || state.loading || state.photoLoading;
  $('preview-note').textContent = state.dirty ? 'Preview includes your unsaved edits.' : 'See all five clues and the full reveal.';
  for (const panel of document.querySelectorAll('.setup-panel,.identity-panel,.crop-panel')) panel.inert = state.locked;
  const target = $('copy-date').value;
  const targetExists = state.days.has(target) || state.overview?.upcoming.some(day => day.date === target && day.name !== null);
  $('copy-puzzle').disabled = !state.hasSaved || state.dirty || state.busy || state.loading || !target || target < state.today || target === state.day || targetExists;
  $('copy-date').disabled = state.busy || state.loading;
  $('copy-hint').textContent = !state.hasSaved ? 'Save this puzzle first, then reuse its portrait, answer, and crops as a new draft.' : state.dirty ? 'Save your edits before copying this puzzle.' : targetExists ? 'That date already has a puzzle. Choose an empty date.' : 'Copies the saved portrait, answer, and all crops into an empty date. The new puzzle stays a draft until you publish it.';
  $('refresh-dashboard').disabled = state.overviewLoading || state.busy || state.loading;
  $('next-gap').disabled = !state.overview?.upcoming.some(day => !day.published) || state.busy || state.loading;
  $('export-month').disabled = !state.calendarLoaded || state.calendarLoading || state.busy;
}

function filteredGroups() {
  const query = state.galleryQuery.trim().toLowerCase();
  if (!query) return state.groups;
  return state.groups.filter(group => group.label.toLowerCase().includes(query));
}
function renderGallery() {
  const epoch = ++state.galleryEpoch;
  const groups = filteredGroups();
  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  state.galleryPage = Math.max(0, Math.min(state.galleryPage, pageCount - 1));
  const start = state.galleryPage * PAGE_SIZE;
  const visible = groups.slice(start, start + PAGE_SIZE);
  const gallery = $('portrait-gallery');
  gallery.replaceChildren();
  $('gallery-count').textContent = `${groups.length} groups`;
  $('gallery-page').textContent = `${state.galleryPage + 1} / ${pageCount}`;
  $('previous-gallery').disabled = state.galleryPage === 0;
  $('next-gallery').disabled = state.galleryPage >= pageCount - 1;
  if (!visible.length) gallery.append(node('p', 'gallery-empty', 'No matching portrait numbers.'));
  for (const group of visible) {
    const button = node('button', 'gallery-portrait');
    button.type = 'button';
    button.classList.toggle('selected', state.group?.id === group.id);
    button.setAttribute('aria-label', `Select ${group.label}, ${group.photos.length} poses`);
    const image = node('img');
    image.alt = '';
    image.loading = 'lazy';
    button.append(image, node('span', '', group.label));
    button.addEventListener('click', () => {
      const photo = group.photos.find(item => item.path === group.cover) || group.photos[0];
      if (photo) choosePhoto(group, photo);
    });
    gallery.append(button);
    loadImage(group.cover).then(({ url }) => {
      if (epoch === state.galleryEpoch && image.isConnected) image.src = url;
    }).catch(() => {
      if (epoch === state.galleryEpoch && image.isConnected) image.alt = 'Preview unavailable';
    });
  }
}
$('portrait-search').addEventListener('input', event => {
  state.galleryQuery = event.target.value;
  state.galleryPage = 0;
  renderGallery();
});
$('previous-gallery').addEventListener('click', () => { state.galleryPage--; renderGallery(); });
$('next-gallery').addEventListener('click', () => { state.galleryPage++; renderGallery(); });
$('change-portrait').addEventListener('click', () => {
  $('gallery-section').hidden = !$('gallery-section').hidden;
  if (!$('gallery-section').hidden) renderGallery();
});
async function choosePhoto(group, photo, options = {}) {
  if (state.locked && !options.saved) return;
  const epoch = ++state.photoEpoch;
  const dayEpoch = state.dayEpoch;
  state.photoLoading = true;
  updateSaveButtons();
  setMessage('editor-message', 'Loading portrait…', 'info');
  const wasDifferentGroup = state.group && state.group.id !== group.id;
  try {
    const loaded = await loadImage(photo.path);
    if (epoch !== state.photoEpoch || dayEpoch !== state.dayEpoch || !state.password) return;
    state.group = group;
    state.photo = photo;
    state.source = loaded.image;
    state.stage = 0;
    if (wasDifferentGroup && !options.saved) {
      state.person = null;
      state.facts = [];
      $('answer-name').value = '';
      renderAnswerStatus();
    }
    state.crops = options.crops?.length === cropCount() ? options.crops.map(crop => clampCrop({ ...crop })) : defaultCrops();
    $('chosen-portrait-thumb').src = loaded.url;
    $('chosen-portrait-label').textContent = group.label;
    $('chosen-portrait-detail').textContent = `${group.photos.length} paired ${group.photos.length === 1 ? 'pose' : 'poses'} · Pose ${group.photos.findIndex(p => p.id === photo.id) + 1} selected`;
    $('chosen-portrait-summary').hidden = false;
    $('change-portrait').hidden = false;
    $('gallery-section').hidden = true;
    $('pose-section').hidden = group.photos.length < 2;
    $('crop-empty').hidden = true;
    $('crop-workspace').hidden = false;
    renderPoses();
    renderStageButtons();
    renderCrop();
    drawReveal($('reveal-canvas'));
    if (!options.saved) markDirty();
    setMessage('editor-message');
    updateSaveButtons();
  } catch (error) { if (epoch === state.photoEpoch) setMessage('editor-message', error.message); }
  finally {
    if (epoch === state.photoEpoch) { state.photoLoading = false; updateSaveButtons(); }
  }
}
function renderPoses() {
  const gallery = $('pose-gallery');
  const group = state.group;
  gallery.replaceChildren();
  for (const [index, photo] of group.photos.entries()) {
    const button = node('button', 'pose-button');
    button.type = 'button';
    button.setAttribute('aria-label', `${group.label}, pose ${index + 1}`);
    button.setAttribute('aria-pressed', String(photo.id === state.photo.id));
    const image = node('img');
    image.alt = '';
    button.append(image, node('span', '', `POSE ${index + 1}`));
    button.addEventListener('click', () => choosePhoto(group, photo));
    gallery.append(button);
    loadImage(photo.path).then(({ url }) => { if (image.isConnected && state.group?.id === group.id) image.src = url; }).catch(() => {});
  }
}

function normalize(value) { return value.replace(/\*/g, '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim(); }
function nameOptions(query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return state.people.filter(person => {
    const parts = normalize(person.name).split(/[\s-]+/);
    return words.every(word => parts.some(part => part.startsWith(word)));
  }).slice(0, 12);
}
function renderOptions() {
  const list = $('answer-options');
  list.replaceChildren();
  state.options = nameOptions($('answer-name').value);
  state.optionIndex = -1;
  if (!$('answer-name').value.trim()) { closeOptions(); return; }
  for (const [index, person] of state.options.entries()) {
    const option = node('li', '', answerLabel(person));
    if (validFacts(person.lookbookFacts).length) option.setAttribute('aria-label', `${person.name}, lookbook clues available`);
    option.id = `answer-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.addEventListener('pointerdown', event => { event.preventDefault(); selectAnswer(person); });
    list.append(option);
  }
  if (!state.options.length) list.append(node('li', 'no-results', 'No matching classmates. Try a first or last name.'));
  list.hidden = false;
  $('answer-name').setAttribute('aria-expanded', 'true');
  $('answer-name').removeAttribute('aria-activedescendant');
}
function closeOptions() {
  $('answer-options').hidden = true;
  $('answer-name').setAttribute('aria-expanded', 'false');
  $('answer-name').removeAttribute('aria-activedescendant');
  state.optionIndex = -1;
}
function selectAnswer(person) {
  if (state.locked) return;
  state.person = person;
  setFacts(person.lookbookFacts);
  $('answer-name').value = answerLabel(person);
  closeOptions();
  renderAnswerStatus();
  markDirty();
}
function validFacts(facts) {
  return Array.isArray(facts) && facts.length === 3 && facts.every(fact => typeof fact === 'string' && fact.trim()) ? facts.slice() : [];
}
function answerLabel(person) { return person.name + (validFacts(person.lookbookFacts).length ? ' *' : ''); }
function cropCount() { return state.facts.length === 3 ? 3 : 5; }
function guessNumber(index) { return index + (state.facts.length ? 3 : 1); }
function setFacts(facts) {
  const previous = state.crops;
  state.facts = validFacts(facts);
  const count = cropCount();
  if (!state.source || !previous.length || previous.length === count) return;
  state.crops = Array.from({length: count}, (_, index) => {
    const position = index * (previous.length - 1) / (count - 1);
    const left = previous[Math.floor(position)], right = previous[Math.ceil(position)], fraction = position % 1;
    return clampCrop(Object.fromEntries(['x', 'y', 'size'].map(key => [key, left[key] + (right[key] - left[key]) * fraction])));
  });
  // Leave room for every later crop, including when switching from three to five.
  for (let index = 0; index < count; index++) {
    const min = index ? state.crops[index - 1].size + 0.015 : 0.04;
    const max = maximumSize() - (count - index - 1) * 0.015;
    state.crops[index] = clampCrop({...state.crops[index], size: Math.min(max, Math.max(min, state.crops[index].size))});
  }
  state.stage = Math.min(state.stage, count - 1);
  renderStageButtons();
  renderCrop();
}
function renderAnswerStatus() {
  $('answer-status').textContent = state.person ? `✓ Answer set: ${answerLabel(state.person)}` : 'Choose a name to set the answer.';
  $('answer-status').classList.toggle('selected', Boolean(state.person));
  const active = Boolean(state.person && state.facts.length);
  $('lookbook-facts').hidden = !active;
  $('lookbook-fact-list').replaceChildren();
  if (active) for (const fact of state.facts) $('lookbook-fact-list').append(node('li', '', fact));
  $('clue-format').textContent = !state.person ? 'Choose a name to see the clue format.' : active ? 'Guess 1: first fact · Guess 2: all three facts · Guesses 3–5: photo crops.' : validFacts(state.person.lookbookFacts).length ? `This saved puzzle uses five photo clues.${state.locked ? '' : ' Reselect this name to use the lookbook clues.'}` : 'Five photo clues, followed by the full-photo reveal.';
  $('crop-description').textContent = active ? 'Set the three square photo clues for guesses 3, 4, and 5.' : 'Drag the square. Zoom out a little more each time.';
}

$('answer-name').addEventListener('input', () => {
  state.person = null;
  renderAnswerStatus();
  renderOptions();
  markDirty();
});
$('answer-name').addEventListener('focus', () => { if (!state.person) renderOptions(); });
$('answer-name').addEventListener('blur', closeOptions);
$('answer-name').addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeOptions(); return; }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (state.optionIndex >= 0 && state.options[state.optionIndex]) selectAnswer(state.options[state.optionIndex]);
    else if (state.options.length === 1 && !$('answer-options').hidden) selectAnswer(state.options[0]);
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  if ($('answer-options').hidden) renderOptions();
  if (!state.options.length) return;
  state.optionIndex = (state.optionIndex + (event.key === 'ArrowDown' ? 1 : -1) + state.options.length) % state.options.length;
  for (const [index, el] of [...$('answer-options').children].entries()) el.setAttribute('aria-selected', String(index === state.optionIndex));
  const option = $(`answer-option-${state.optionIndex}`);
  $('answer-name').setAttribute('aria-activedescendant', option.id);
  option.scrollIntoView({ block: 'nearest' });
});

function maximumSize() { return Math.min(1, state.source.naturalHeight / state.source.naturalWidth); }
function clampCrop(crop) {
  const ratio = state.source.naturalWidth / state.source.naturalHeight;
  const size = Math.min(maximumSize(), Math.max(0.04, Number(crop.size) || 0.1));
  return { x: Math.min(1 - size, Math.max(0, Number(crop.x) || 0)), y: Math.min(1 - size * ratio, Math.max(0, Number(crop.y) || 0)), size };
}
function defaultCrops() {
  const max = maximumSize();
  const ratio = state.source.naturalWidth / state.source.naturalHeight;
  return (cropCount() === 3 ? [0.16, 0.45, 1] : [0.16, 0.28, 0.45, 0.7, 1]).map(fraction => {
    const size = max * fraction;
    return clampCrop({ x: (1 - size) / 2, y: 0.3 - size * ratio / 2, size });
  });
}
function drawSquare(canvas, crop) {
  const context = canvas.getContext('2d');
  const width = state.source.naturalWidth;
  const height = state.source.naturalHeight;
  const side = crop.size * width;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(state.source, crop.x * width, crop.y * height, side, side, 0, 0, canvas.width, canvas.height);
}
function drawReveal(canvas) {
  const context = canvas.getContext('2d');
  context.fillStyle = '#17102e';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / state.source.naturalWidth, canvas.height / state.source.naturalHeight);
  const width = state.source.naturalWidth * scale;
  const height = state.source.naturalHeight * scale;
  context.drawImage(state.source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}
function renderStageButtons() {
  const container = $('crop-stages');
  container.replaceChildren();
  container.style.gridTemplateColumns = `repeat(${cropCount()}, minmax(0, 1fr))`;
  container.setAttribute('aria-label', `${cropCount()} playable photo crops`);
  for (let index = 0; index < cropCount(); index++) {
    const button = node('button', 'crop-stage');
    button.type = 'button';
    button.setAttribute('aria-label', `Edit photo crop for guess ${guessNumber(index)}`);
    button.setAttribute('aria-pressed', String(index === state.stage));
    const canvas = node('canvas');
    canvas.width = 128;
    canvas.height = 128;
    canvas.id = `stage-preview-${index}`;
    button.append(canvas, node('span', '', `GUESS ${guessNumber(index)}`));
    button.addEventListener('click', () => { state.stage = index; renderCrop(); });
    container.append(button);
  }
}
function renderCrop() {
  if (!state.source || !state.crops.length) return;
  const crop = state.crops[state.stage];
  const canvas = $('source-canvas');
  const width = state.source.naturalWidth;
  const height = state.source.naturalHeight;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const x = crop.x * width;
  const y = crop.y * height;
  const size = crop.size * width;
  context.drawImage(state.source, 0, 0);
  context.fillStyle = '#100b20a6';
  context.fillRect(0, 0, width, y);
  context.fillRect(0, y + size, width, height - y - size);
  context.fillRect(0, y, x, size);
  context.fillRect(x + size, y, width - x - size, size);
  context.strokeStyle = '#dbff59';
  context.lineWidth = Math.max(2, width / 160);
  context.strokeRect(x, y, size, size);
  context.fillStyle = '#dbff59';
  const handle = Math.max(5, width / 55);
  for (const [cx, cy] of [[x, y], [x + size, y], [x, y + size], [x + size, y + size]]) context.fillRect(cx - handle / 2, cy - handle / 2, handle, handle);
  drawSquare($('preview-canvas'), crop);
  for (let index = 0; index < cropCount(); index++) {
    drawSquare($(`stage-preview-${index}`), state.crops[index]);
    $('crop-stages').children[index].setAttribute('aria-pressed', String(index === state.stage));
  }
  $('stage-title').textContent = `CROP ${state.stage + 1} OF ${cropCount()} · GUESS ${guessNumber(state.stage)}`;
  const min = state.stage === 0 ? 0.04 : state.crops[state.stage - 1].size + 0.015;
  const max = maximumSize() - (cropCount() - state.stage - 1) * 0.015;
  $('crop-size').min = min.toFixed(4);
  $('crop-size').max = max.toFixed(4);
  $('crop-size').value = crop.size;
  $('crop-size-value').value = `${Math.round(crop.size / maximumSize() * 100)}%`;
  $('crop-size-hint').textContent = state.stage === 0 ? 'Start tight. Later crops automatically stay wider.' : 'This crop stays wider than the previous clue. Later crops adjust if needed.';
  $('previous-stage').disabled = state.stage === 0;
  $('next-stage').disabled = state.stage === cropCount() - 1;
}
function setCropSize(value) {
  if (!state.source || state.locked) return;
  const current = state.crops[state.stage];
  const ratio = state.source.naturalWidth / state.source.naturalHeight;
  const min = state.stage === 0 ? 0.04 : state.crops[state.stage - 1].size + 0.015;
  const max = maximumSize() - (cropCount() - state.stage - 1) * 0.015;
  const size = Math.min(max, Math.max(min, Number(value)));
  state.crops[state.stage] = clampCrop({ x: current.x + (current.size - size) / 2, y: current.y + (current.size - size) * ratio / 2, size });
  for (let index = state.stage + 1; index < cropCount(); index++) {
    const existing = state.crops[index];
    const nextSize = Math.max(existing.size, state.crops[index - 1].size + 0.015);
    state.crops[index] = clampCrop({ x: existing.x + (existing.size - nextSize) / 2, y: existing.y + (existing.size - nextSize) * ratio / 2, size: nextSize });
  }
  renderCrop();
  markDirty();
}
$('crop-size').addEventListener('input', event => setCropSize(event.target.value));
$('previous-stage').addEventListener('click', () => { state.stage = Math.max(0, state.stage - 1); renderCrop(); });
$('next-stage').addEventListener('click', () => { state.stage = Math.min(cropCount() - 1, state.stage + 1); renderCrop(); });
let drag = null;
function sourcePoint(event) {
  const rect = $('source-canvas').getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
}
$('source-canvas').addEventListener('pointerdown', event => {
  if (!state.source || state.locked || state.loading || state.busy || event.button > 0) return;
  event.preventDefault();
  const point = sourcePoint(event);
  const crop = state.crops[state.stage];
  const ratio = state.source.naturalWidth / state.source.naturalHeight;
  const inside = point.x >= crop.x && point.x <= crop.x + crop.size && point.y >= crop.y && point.y <= crop.y + crop.size * ratio;
  drag = { pointerId: event.pointerId, x: inside ? point.x - crop.x : crop.size / 2, y: inside ? point.y - crop.y : crop.size * ratio / 2 };
  $('source-canvas').setPointerCapture(event.pointerId);
  moveCrop(event);
});
function moveCrop(event) {
  if (!drag || event.pointerId !== drag.pointerId || !state.source || state.locked) return;
  const point = sourcePoint(event);
  state.crops[state.stage] = clampCrop({ ...state.crops[state.stage], x: point.x - drag.x, y: point.y - drag.y });
  renderCrop();
  markDirty();
}
$('source-canvas').addEventListener('pointermove', moveCrop);
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('source-canvas').addEventListener(name, () => { drag = null; });
$('source-canvas').addEventListener('keydown', event => {
  if (!state.source || state.locked) return;
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (moves[event.key]) {
    event.preventDefault();
    const step = event.shiftKey ? 0.04 : 0.01;
    const crop = state.crops[state.stage];
    state.crops[state.stage] = clampCrop({ ...crop, x: crop.x + moves[event.key][0] * step, y: crop.y + moves[event.key][1] * step });
    renderCrop();
    markDirty();
  } else if (['+', '=', '-'].includes(event.key)) {
    event.preventDefault();
    setCropSize(state.crops[state.stage].size + (event.key === '-' ? -0.015 : 0.015));
  }
});

async function savePuzzle(published) {
  if (state.busy || state.loading || state.photoLoading || state.locked || !state.source || !state.person || !state.photo) return;
  closeOptions();
  const date = state.day;
  const epoch = state.dayEpoch;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 640;
  const images = state.crops.map(crop => { drawSquare(canvas, crop); return canvas.toDataURL('image/jpeg', 0.85); });
  drawReveal(canvas);
  const reveal = canvas.toDataURL('image/jpeg', 0.85);
  const body = { date, personId: state.person.id, photoId: state.photo.id, crops: state.crops, images, reveal, published, useLookbook: state.facts.length === 3 };
  state.busy = true;
  document.querySelector('.admin-editor').inert = true;
  document.querySelector('.admin-sidebar').inert = true;
  $('workspace').dataset.busy = 'true';
  updateSaveButtons();
  setMessage('editor-message', published ? 'Publishing this day…' : 'Saving your draft…', 'info');
  try {
    const saved = await api('/api/admin/puzzle', { method: 'POST', body: JSON.stringify(body) });
    if (epoch !== state.dayEpoch || !state.password) return;
    if (saved.puzzle) { state.facts = validFacts(saved.puzzle.facts); renderAnswerStatus(); }
    state.published = published;
    state.hasSaved = true;
    state.dirty = false;
    state.days.set(date, { date, personId: body.personId, name: state.people.find(person => person.id === body.personId).name, photoId: body.photoId, published });
    updateStatus();
    renderCalendar();
    void loadOverview(date);
    setMessage('editor-message', published ? (date === state.today ? 'Today’s M2ordle is live.' : `Published for ${prettyDate(date)}. Players will see it at midnight Central.`) : `Draft saved for ${prettyDate(date)}. Publish it when it’s ready.`, 'success');
  } catch (error) {
    if (epoch === state.dayEpoch) {
      setMessage('editor-message', error.message);
      $('save-note').textContent = error.message;
      $('save-note').classList.add('save-error');
    }
  } finally {
    if (epoch === state.dayEpoch) {
      state.busy = false;
      document.querySelector('.admin-editor').inert = false;
      document.querySelector('.admin-sidebar').inert = false;
      $('workspace').dataset.busy = 'false';
      updateSaveButtons();
    }
  }
}
$('save-draft').addEventListener('click', () => savePuzzle(false));
$('publish-puzzle').addEventListener('click', () => savePuzzle(true));
