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
export function namePopupLayout(rect, bounds, contentHeight = 230) {
  const margin = 8, gap = 6;
  const width = Math.max(0, Math.min(rect.width, bounds.right - bounds.left - margin * 2));
  const below = Math.max(0, bounds.bottom - margin - rect.bottom - gap);
  const aboveSpace = Math.max(0, rect.top - gap - bounds.top - margin);
  // Choose a side independently of the number of matches, so typing never flips it.
  const above = below < 230 && aboveSpace > below;
  const maxHeight = Math.min(230, above ? aboveSpace : below);
  const height = Math.min(contentHeight, maxHeight);
  const left = Math.max(bounds.left + margin, Math.min(rect.left, bounds.right - margin - width));
  const top = above ? rect.top - gap - height : rect.bottom + gap;
  return {left, top, width, maxHeight, above};
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
    const rect = input.getBoundingClientRect(), viewport = window.visualViewport;
    const bounds = {left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0};
    bounds.right = bounds.left + (viewport?.width || document.documentElement.clientWidth);
    bounds.bottom = bounds.top + (viewport?.height || window.innerHeight);
    const dialog = input.closest('dialog');
    if (dialog) {
      const frame = dialog.getBoundingClientRect();
      bounds.left = Math.max(bounds.left, frame.left); bounds.right = Math.min(bounds.right, frame.right);
      bounds.top = Math.max(bounds.top, frame.top); bounds.bottom = Math.min(bounds.bottom, frame.bottom);
    }
    let layout = namePopupLayout(rect, bounds);
    list.style.width = `${layout.width}px`; list.style.maxHeight = `${layout.maxHeight}px`;
    layout = namePopupLayout(rect, bounds, list.getBoundingClientRect().height);
    list.style.left = `${layout.left}px`; list.style.top = `${layout.top}px`;
    list.style.visibility = rect.bottom <= bounds.top || rect.top >= bounds.bottom || layout.maxHeight < 40 ? 'hidden' : 'visible';
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
