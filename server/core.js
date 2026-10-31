export const MAX_GUESSES = 5;
export const TIME_ZONE = 'America/Chicago';
const dateFormat = new Intl.DateTimeFormat('en-CA', {timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'});
const hourFormat = new Intl.DateTimeFormat('en-US', {timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23'});
export function centralDate(now = Date.now()) {
  const parts = Object.fromEntries(dateFormat.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export function dayDistance(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000); }
export function nextCentralMidnight(now = Date.now()) {
  const next = new Date(Date.parse(centralDate(now) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const sixUTC = Date.parse(next + 'T06:00:00Z');
  const hour = Number(hourFormat.format(new Date(sixUTC)));
  return new Date(sixUTC - hour * 3600000).toISOString();
}
export function score(status, guesses) { return status === 'won' ? MAX_GUESSES + 1 - guesses : 0; }
export function publicGuesses(guesses, people) {
  return guesses.map(g => ({personId: g.personId, name: people.get(g.personId)?.name || 'Classmate', correct: g.correct}));
}
export function validateCrops(crops, photo, count = MAX_GUESSES) {
  if (![3, MAX_GUESSES].includes(count) || !Array.isArray(crops) || crops.length !== count) throw new Error(count === 3 ? 'Choose all three photo crops.' : 'Choose all five crops.');
  const ratio = photo.width / photo.height;
  if (!(ratio > 0 && Number.isFinite(ratio))) throw new Error('This portrait has invalid dimensions.');
  let previous = 0;
  return crops.map(crop => {
    if (!crop || !['x', 'y', 'size'].every(key => typeof crop[key] === 'number' && Number.isFinite(crop[key]))) throw new Error('Each crop needs a valid position and size.');
    const {x, y, size} = crop;
    if (x < 0 || y < 0 || size < 0.02 || size > 1 || x + size > 1.000001 || y + size * ratio > 1.000001) throw new Error('Keep each square crop inside the portrait.');
    if (size + 0.000001 < previous) throw new Error('Each crop must zoom out or stay the same size.');
    previous = size;
    return {x, y, size};
  });
}
export function validateJpeg(value) {
  if (typeof value !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 1000000) throw new Error('Each image must be a JPEG smaller than 750 KB.');
  const encoded = value.slice('data:image/jpeg;base64,'.length);
  let data;
  try { data = atob(encoded); } catch { throw new Error('An image is not valid base64.'); }
  if (data.length < 16 || data.charCodeAt(0) !== 255 || data.charCodeAt(1) !== 216 || data.charCodeAt(data.length - 2) !== 255 || data.charCodeAt(data.length - 1) !== 217) throw new Error('An image is not a valid JPEG.');
  return encoded;
}
export function calculateStats(rows, today, classRows, publishedDates = []) {
  const published = new Set(publishedDates);
  const continuesStreak = (from, to) => {
    const end = Date.parse(to + 'T00:00:00Z');
    // Only intervening days can break a streak; today's puzzle can still be completed.
    for (let time = Date.parse(from + 'T00:00:00Z') + 86400000; time < end; time += 86400000) {
      const date = new Date(time), weekday = date.getUTCDay();
      if ((weekday !== 0 && weekday !== 6) || published.has(date.toISOString().slice(0, 10))) return false;
    }
    return true;
  };
  const completed = rows.filter(r => r.status !== 'playing').sort((a, b) => a.date.localeCompare(b.date));
  const distribution = Array(MAX_GUESSES).fill(0), todayDistribution = Array(MAX_GUESSES).fill(0);
  let wins = 0, maxStreak = 0, running = 0, prior = null;
  for (const row of completed) {
    if (row.status === 'won') {
      const count = JSON.parse(row.guesses).length;
      distribution[count - 1]++;
      wins++;
      running = prior && continuesStreak(prior, row.date) ? running + 1 : 1;
      maxStreak = Math.max(maxStreak, running);
    } else running = 0;
    prior = row.date;
  }
  const last = completed.at(-1);
  const streak = last && continuesStreak(last.date, today) ? running : 0;
  let todayFailed = 0;
  for (const row of classRows) {
    if (row.status === 'won') todayDistribution[JSON.parse(row.guesses).length - 1]++;
    else if (row.status === 'lost') todayFailed++;
  }
  return {played: completed.length, wins, streak, maxStreak, distribution, todayDistribution, todayFailed};
}
