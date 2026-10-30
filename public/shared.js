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
export function namePopupHeight(rect, viewportHeight, dialogTop = null) {
  const height = Math.max(64, Math.min(200, viewportHeight * .4));
  return dialogTop === null ? height : Math.max(64, Math.min(height, rect.top - dialogTop - 14));
}
export function namePicker(container, people, {placeholder = 'Type a classmate’s name…', label = 'Classmate name', onSelect = () => {}, excluded = []} = {}) {
  const id = `names-${crypto.randomUUID()}`;
  const input = document.createElement('input');
  input.type = 'text'; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('aria-label', label); input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id); input.setAttribute('aria-expanded', 'false');
  const list = document.createElement('ul'); list.id = id; list.className = 'name-options'; list.setAttribute('role', 'listbox'); list.hidden = true;
  const announce = document.createElement('span'); announce.className = 'sr-only'; announce.setAttribute('aria-live', 'polite');
  container.classList.add('name-picker'); container.append(input, list, announce);
  let selected = null, results = [], active = -1, positionFrame = 0, positioning = null;
  const lifetime = new AbortController();
  const close = () => {
    list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1;
    positioning?.abort(); positioning = null; cancelAnimationFrame(positionFrame); positionFrame = 0;
  };
  function destroy() { close(); lifetime.abort(); }
  function positionList() {
    positionFrame = 0;
    if (!input.isConnected) return destroy();
    if (list.hidden) return;
    // Anchor in CSS to the input. Safari's keyboard can report mismatched visual
    // viewport offsets; those offsets must never hide or displace the matches.
    const dialog = input.closest('dialog');
    list.style.maxHeight = `${namePopupHeight(input.getBoundingClientRect(), window.visualViewport?.height || window.innerHeight, dialog?.getBoundingClientRect().top ?? null)}px`;
  }
  function trackPosition() {
    if (positioning) return;
    positioning = new AbortController();
    const schedule = event => {
      if (event.target === list || positionFrame) return;
      positionFrame = requestAnimationFrame(positionList);
    };
    const options = {passive: true, signal: positioning.signal};
    window.addEventListener('scroll', schedule, {...options, capture: true});
    window.addEventListener('resize', schedule, options);
    window.visualViewport?.addEventListener('scroll', schedule, options);
    window.visualViewport?.addEventListener('resize', schedule, options);
  }
  function select(person) { selected = person; input.value = person.name; close(); onSelect(person); }
  function highlight(index) {
    active = index; [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${id}-${active}`);
      const option = list.children[active];
      const top = option.offsetTop, bottom = top + option.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
  }
  function show() {
    results = searchPeople(people.filter(p => !excluded.includes(p.id)), input.value); list.replaceChildren(); active = -1; input.removeAttribute('aria-activedescendant');
    if (!input.value.trim()) return close();
    for (const [i, person] of results.entries()) {
      const li = document.createElement('li'); li.id = `${id}-${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false'); li.textContent = person.name;
      li.addEventListener('click', () => select(person)); list.append(li);
    }
    if (!results.length) { const li = document.createElement('li'); li.className = 'no-match'; li.textContent = 'No matching classmates'; li.setAttribute('role','presentation'); list.append(li); }
    list.hidden = false; list.scrollTop = 0; positionList(); trackPosition();
    input.setAttribute('aria-expanded', 'true'); announce.textContent = `${results.length} matching classmates`;
  }
  // Preserve input focus on a tap/click without cancelling touch-drag scrolling.
  list.addEventListener('mousedown', e => e.preventDefault(), {signal: lifetime.signal});
  input.addEventListener('input', () => { selected = null; onSelect(null); show(); }, {signal: lifetime.signal});
  input.addEventListener('focus', () => { if (!selected) show(); }, {signal: lifetime.signal});
  input.addEventListener('blur', close, {signal: lifetime.signal});
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (list.hidden) show(); if (results.length) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    }
    if (e.key === 'Enter' && !list.hidden && results.length) { e.preventDefault(); select(results[active >= 0 ? active : 0]); }
  }, {signal: lifetime.signal});
  input.closest('dialog')?.addEventListener('close', destroy, {once: true, signal: lifetime.signal});
  return {input, destroy, get selected(){return selected;}, clear(){input.value='';selected=null;close();onSelect(null);}};
}
