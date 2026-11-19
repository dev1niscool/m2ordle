import {namePicker} from './shared.js?v=19';

const PAGE_SIZE = 12;

export function createWinnerEditor({root, api, loadImage}) {
  let generation = 0, photoGeneration = 0, galleryGeneration = 0;
  let people = [], groups = [], picker = null, person = null, photo = null, group = null, source = null;
  let saved = null, leader = null, photoPersonId = null, page = 0, query = '', dirty = false, busy = false;
  const find = selector => root.querySelector(selector);
  const element = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  function message(text = '', kind = 'error') {
    const target = find('[data-winner-message]');
    if (target) { target.textContent = text; target.dataset.kind = kind; }
  }
  function reset() {
    generation++; photoGeneration++; galleryGeneration++;
    picker?.destroy(); picker = null;
    people = []; groups = []; person = null; photo = null; group = null; source = null;
    saved = null; leader = null; photoPersonId = null; dirty = false; busy = false;
    root.replaceChildren();
  }
  function controls() {
    if (!picker) return;
    picker.input.disabled = busy;
    find('[data-winner-choose]').disabled = busy || !person;
    find('[data-winner-save]').disabled = busy || !dirty || !person || !photo || !source;
    find('[data-winner-remove]').disabled = busy || !saved;
    find('[data-winner-remove]').hidden = !saved;
    find('[data-winner-refresh]').disabled = busy;
    find('[data-winner-gallery-wrap]').inert = busy;
    find('[data-winner-save]').textContent = 'Save winner portrait';
    const status = find('[data-winner-status]');
    status.textContent = dirty ? 'Unsaved portrait changes.' : saved ? `Saved for ${saved.name}.` : 'No winner portrait saved yet.';
    status.classList.toggle('winner-saved', !dirty && Boolean(saved));
  }
  function paintPreview() {
    const canvas = find('canvas'), empty = find('[data-winner-empty]');
    canvas.hidden = !source; empty.hidden = Boolean(source);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#140e21'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (source) {
      const scale = Math.min(canvas.width / source.naturalWidth, canvas.height / source.naturalHeight);
      const width = source.naturalWidth * scale, height = source.naturalHeight * scale;
      ctx.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    }
    find('[data-winner-caption]').textContent = person ? `Portrait for ${person.name}` : 'Choose the classmate whose portrait you are saving.';
    find('[data-winner-selected]').textContent = photo && group ? `${group.label} · Pose ${group.photos.findIndex(item => item.id === photo.id) + 1}` : 'Choose their portrait from the class library.';
  }
  function setPerson(next) {
    person = next;
    if (next && photoPersonId && next.id !== photoPersonId) {
      photoGeneration++; photo = null; group = null; source = null; photoPersonId = null;
      find('[data-winner-poses]').replaceChildren();
      if (!find('[data-winner-gallery-wrap]').hidden) renderGallery();
      message('Choose a portrait for the newly selected classmate.', 'info');
    } else message();
    dirty = true; paintPreview(); controls();
  }
  function renderLeader() {
    find('[data-winner-leader]').textContent = leader ? `Current first place: ${leader.name} · ${leader.points} points` : 'No verified class scores yet.';
    find('[data-winner-rule]').textContent = saved && leader && saved.personId !== leader.personId
      ? `${saved.name}’s portrait is saved. It will appear only if they finish first; choose ${leader.name}’s portrait to match the current leader.`
      : 'The homepage always congratulates the actual first-place classmate. A saved portrait appears only when its name matches the winner.';
  }
  function renderGallery() {
    const current = ++galleryGeneration, session = generation;
    const filtered = groups.filter(item => item.label.toLowerCase().includes(query.trim().toLowerCase()));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages - 1));
    const gallery = find('[data-winner-gallery]'); gallery.replaceChildren();
    find('[data-winner-page]').textContent = `Page ${page + 1} of ${pages}`;
    find('[data-winner-count]').textContent = `${filtered.length} portrait groups`;
    find('[data-winner-previous]').disabled = page === 0;
    find('[data-winner-next]').disabled = page === pages - 1;
    if (!filtered.length) gallery.append(element('p', 'gallery-empty', 'No matching portrait numbers.'));
    for (const item of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const button = element('button', 'gallery-portrait'); button.type = 'button';
      button.setAttribute('aria-label', `Winner portrait: ${item.label}, ${item.photos.length} poses`);
      button.classList.toggle('selected', group?.id === item.id);
      const image = element('img'); image.alt = ''; image.loading = 'lazy';
      button.append(image, element('span', '', item.label)); gallery.append(button);
      button.onclick = () => choosePhoto(item, item.photos.find(candidate => candidate.path === item.cover) || item.photos[0]);
      loadImage(item.cover).then(({url}) => {
        if (session === generation && current === galleryGeneration && image.isConnected) image.src = url;
      }).catch(() => { if (session === generation && current === galleryGeneration && image.isConnected) image.alt = 'Preview unavailable'; });
    }
  }
  function renderPoses() {
    const target = find('[data-winner-poses]'); target.replaceChildren();
    if (!group) return;
    const selectedGroup = group, session = generation;
    target.append(element('p', 'winner-field-label', 'Choose a pose'));
    const list = element('div', 'pose-gallery'); target.append(list);
    for (const [index, candidate] of group.photos.entries()) {
      const button = element('button', 'pose-button'); button.type = 'button';
      button.setAttribute('aria-label', `Winner portrait pose ${index + 1}`);
      button.setAttribute('aria-pressed', String(photo?.id === candidate.id));
      const image = element('img'); image.alt = '';
      button.append(image, element('span', '', `Pose ${index + 1}`)); list.append(button);
      button.onclick = () => choosePhoto(selectedGroup, candidate);
      loadImage(candidate.path).then(({url}) => {
        if (session === generation && group === selectedGroup && image.isConnected) image.src = url;
      }).catch(() => { if (session === generation && image.isConnected) image.alt = 'Preview unavailable'; });
    }
  }
  async function choosePhoto(nextGroup, nextPhoto) {
    if (!person || busy || !nextPhoto) return;
    const session = generation, request = ++photoGeneration, personId = person.id;
    busy = true; controls(); message('Loading the selected portrait…', 'info');
    try {
      const loaded = await loadImage(nextPhoto.path);
      if (session !== generation || request !== photoGeneration || person?.id !== personId) return;
      group = nextGroup; photo = nextPhoto; source = loaded.image; photoPersonId = personId; dirty = true;
      paintPreview(); renderPoses(); renderGallery(); message('Review the portrait, then save it for this classmate.', 'info');
    } catch (error) { if (session === generation && request === photoGeneration) message(error.message); }
    finally { if (session === generation && request === photoGeneration) { busy = false; controls(); } }
  }
  async function fetchSelection() {
    const session = generation;
    busy = true; controls(); message('Loading the winner portrait…', 'info');
    try {
      const data = await api('/api/admin/winner');
      if (session !== generation) return;
      saved = data.selection; leader = data.leader;
      person = people.find(item => item.id === (saved?.personId || leader?.personId)) || null;
      picker.input.value = person?.name || '';
      photo = null; group = null; source = null; photoPersonId = null;
      if (saved) {
        group = groups.find(item => item.photos.some(candidate => candidate.id === saved.photoId)) || null;
        photo = group?.photos.find(item => item.id === saved.photoId) || null;
        photoPersonId = saved.personId;
        const loaded = await loadImage(`${saved.image}?v=${encodeURIComponent(saved.updated)}`);
        if (session !== generation) return;
        source = loaded.image;
      }
      dirty = false; paintPreview(); renderLeader(); renderPoses(); message();
    } catch (error) {
      if (session !== generation) return;
      paintPreview(); renderLeader(); message(error.message);
    } finally { if (session === generation) { busy = false; controls(); } }
  }
  async function save(clear = false) {
    if (busy || (!clear && (!person || !photo || !source))) return;
    const session = generation;
    const body = clear ? {clear: true} : {personId: person.id, photoId: photo.id, image: find('canvas').toDataURL('image/jpeg', .9)};
    busy = true; controls(); message(clear ? 'Removing the saved winner portrait…' : 'Saving the winner portrait…', 'info');
    try {
      const data = await api('/api/admin/winner', {method: 'POST', body: JSON.stringify(body)});
      if (session !== generation) return;
      saved = data.selection; leader = data.leader; dirty = false;
      if (clear) {
        photoGeneration++; photo = null; group = null; source = null; photoPersonId = null;
        find('[data-winner-poses]').replaceChildren(); paintPreview();
      }
      renderLeader();
      message(clear ? 'Winner portrait removed. The congratulations will still show the actual winner’s name.' : `Portrait saved for ${saved.name}. It is ready for the November 19 homepage.`, 'success');
    } catch (error) { if (session === generation) message(error.message); }
    finally { if (session === generation) { busy = false; controls(); } }
  }
  async function load(data) {
    reset(); people = data.people; groups = data.groups; page = 0; query = '';
    root.innerHTML = `<div class="winner-panel-heading"><div><p class="admin-eyebrow">THE CLASS FINALE</p><h2 id="winner-heading">First-place celebration</h2></div><button type="button" class="admin-button admin-button-small" data-winner-refresh>Refresh winner</button></div><p class="winner-intro">Choose a portrait now. It appears starting November 19 if this classmate finishes first.</p><p class="winner-leader" data-winner-leader>Loading the current leader…</p><div class="winner-editor-layout"><figure class="winner-admin-preview"><div class="winner-admin-frame"><canvas width="560" height="700" aria-label="Winner portrait preview" hidden></canvas><div class="winner-photo-empty" data-winner-empty><span aria-hidden="true">✦</span><p>Select a portrait</p></div></div><figcaption data-winner-caption></figcaption></figure><div class="winner-editor-controls"><label class="winner-field-label" data-winner-name-label>Portrait belongs to</label><div data-winner-name></div><p class="admin-muted" data-winner-selected></p><button type="button" class="admin-button" data-winner-choose>Choose portrait</button><p class="winner-rule" data-winner-rule></p><p class="winner-save-status" data-winner-status></p><div class="winner-save-actions"><button type="button" class="admin-button admin-primary" data-winner-save disabled>Save winner portrait</button><button type="button" class="admin-button" data-winner-remove hidden>Remove portrait</button></div></div></div><div class="winner-gallery-wrap" data-winner-gallery-wrap hidden><div class="winner-gallery-toolbar"><label>Find a portrait group<input type="search" data-winner-search placeholder="Portrait number…" autocomplete="off"></label><span data-winner-count></span><button type="button" class="admin-button admin-button-small" data-winner-gallery-close>Close library</button></div><div class="winner-portrait-gallery" data-winner-gallery aria-label="Winner portrait library"></div><div class="winner-gallery-pagination"><button type="button" class="admin-button admin-button-small" data-winner-previous>Previous</button><span data-winner-page></span><button type="button" class="admin-button admin-button-small" data-winner-next>Next</button></div><div data-winner-poses></div></div><p class="admin-message winner-message" data-winner-message role="status" aria-live="polite"></p>`;
    picker = namePicker(find('[data-winner-name]'), people, {label: 'Winner portrait classmate', placeholder: 'Find their name…', onSelect: setPerson});
    picker.input.id = 'winner-classmate'; find('[data-winner-name-label]').htmlFor = picker.input.id;
    find('[data-winner-save]').onclick = () => save();
    find('[data-winner-remove]').onclick = () => save(true);
    find('[data-winner-choose]').onclick = () => {
      find('[data-winner-gallery-wrap]').hidden = false; renderGallery(); renderPoses();
    };
    find('[data-winner-gallery-close]').onclick = () => { find('[data-winner-gallery-wrap]').hidden = true; };
    find('[data-winner-search]').oninput = event => { query = event.target.value; page = 0; renderGallery(); };
    find('[data-winner-previous]').onclick = () => { page--; renderGallery(); };
    find('[data-winner-next]').onclick = () => { page++; renderGallery(); };
    find('[data-winner-refresh]').onclick = () => {
      if (dirty) { message('Save your portrait changes before refreshing the winner.', 'info'); return; }
      void fetchSelection();
    };
    await fetchSelection();
  }
  return {load, reset, get dirty() { return dirty; }};
}
