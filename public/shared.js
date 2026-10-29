export const MAX_GUESSES = 5;
export const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export function searchPeople(people, query) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return people.filter(person => terms.every(term => normalize(person.name).split(/[\s'-]+/).some(part => part.startsWith(term)))).slice(0, 40);
}
export function shareText(game) {
  const squares = Array.from({length: MAX_GUESSES}, (_, index) => {
    const guess = game.guesses[index];
    return guess ? (guess.correct ? '🟩' : '🟥') : '⬛';
  }).join(' ');
  return `M2ordle #${game.number}\n🏥 ${squares}\n\n${game.shareUrl || 'https://dev1niscool.github.io/m2ordle'}`;
}
export function countdown(reset, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((new Date(reset).getTime() - now) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}
export function namePicker(container, people, {placeholder = 'Type a classmate’s name…', label = 'Classmate name', onSelect = () => {}, excluded = []} = {}) {
  const id = `names-${crypto.randomUUID()}`;
  const input = document.createElement('input');
  input.type = 'text'; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('aria-label', label); input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id); input.setAttribute('aria-expanded', 'false');
  const list = document.createElement('ul'); list.id = id; list.className = 'name-options'; list.setAttribute('role', 'listbox'); list.hidden = true;
  const announce = document.createElement('span'); announce.className = 'sr-only'; announce.setAttribute('aria-live', 'polite');
  container.classList.add('name-picker'); container.append(input, list, announce);
  let selected = null, results = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  function select(person) { selected = person; input.value = person.name; close(); onSelect(person); }
  function highlight(index) {
    active = index; [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) { input.setAttribute('aria-activedescendant', `${id}-${active}`); list.children[active]?.scrollIntoView({block:'nearest'}); }
  }
  function show() {
    results = searchPeople(people.filter(p => !excluded.includes(p.id)), input.value); list.replaceChildren(); active = -1;
    if (!input.value.trim()) return close();
    for (const [i, person] of results.entries()) {
      const li = document.createElement('li'); li.id = `${id}-${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false'); li.textContent = person.name;
      li.addEventListener('pointerdown', e => { e.preventDefault(); select(person); }); list.append(li);
    }
    if (!results.length) { const li = document.createElement('li'); li.className = 'no-match'; li.textContent = 'No matching classmates'; li.setAttribute('role','presentation'); list.append(li); }
    list.hidden = false; input.setAttribute('aria-expanded', 'true'); announce.textContent = `${results.length} matching classmates`;
  }
  input.addEventListener('input', () => { selected = null; onSelect(null); show(); });
  input.addEventListener('focus', () => { if (!selected) show(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (list.hidden) show(); if (results.length) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    }
    if (e.key === 'Enter' && !list.hidden && results.length) { e.preventDefault(); select(results[active >= 0 ? active : 0]); }
  });
  return {input, get selected(){return selected;}, clear(){input.value='';selected=null;close();onSelect(null);}};
}
