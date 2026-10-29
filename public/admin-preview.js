let activePreview = null;

export function closePuzzlePreview() {
  if (!activePreview) return;
  const dialog = activePreview;
  activePreview = null;
  dialog.close();
  dialog.remove();
}

export function openPuzzlePreview({ source, crops, name, date }) {
  if (!source?.naturalWidth || !source?.naturalHeight || crops?.length !== 5) return;
  closePuzzlePreview();
  const frames = crops.map(crop => ({ ...crop }));
  let stage = 0;
  const dialog = document.createElement('dialog');
  dialog.className = 'admin-preview-dialog';
  dialog.setAttribute('aria-labelledby', 'preview-heading');
  dialog.innerHTML = `<div class="preview-heading"><div><p class="admin-eyebrow">PLAYER PREVIEW</p><h2 id="preview-heading"></h2></div><button type="button" class="admin-icon-button" aria-label="Close preview">×</button></div>
    <p class="preview-note">Try the current clues before publishing. This preview won’t record a game.</p>
    <div class="preview-frame"><canvas width="640" height="640" role="img"></canvas></div>
    <div class="preview-caption" aria-live="polite"><strong></strong><p></p></div>
    <div class="preview-steps" aria-label="Preview progress"></div>
    <div class="preview-navigation"><button type="button" class="admin-button" data-previous>← Previous</button><button type="button" class="admin-button admin-primary" data-next>Wrong guess →</button></div>
    <button type="button" class="admin-link-button preview-reveal" data-reveal>Reveal answer</button>`;
  dialog.querySelector('h2').textContent = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const canvas = dialog.querySelector('canvas');
  const context = canvas.getContext('2d');
  const previous = dialog.querySelector('[data-previous]');
  const next = dialog.querySelector('[data-next]');
  const reveal = dialog.querySelector('[data-reveal]');
  const steps = dialog.querySelector('.preview-steps');
  for (let index = 0; index < 6; index++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = index < 5 ? String(index + 1) : 'Reveal';
    button.setAttribute('aria-label', index < 5 ? `Preview clue ${index + 1}` : 'Preview full-photo reveal');
    button.onclick = () => { stage = index; paint(); };
    steps.append(button);
  }
  function paint() {
    const full = stage === 5;
    context.fillStyle = '#17102e';
    context.fillRect(0, 0, 640, 640);
    if (full) {
      const scale = Math.min(640 / source.naturalWidth, 640 / source.naturalHeight);
      const width = source.naturalWidth * scale, height = source.naturalHeight * scale;
      context.drawImage(source, (640 - width) / 2, (640 - height) / 2, width, height);
    } else {
      const crop = frames[stage], side = crop.size * source.naturalWidth;
      context.drawImage(source, crop.x * source.naturalWidth, crop.y * source.naturalHeight, side, side, 0, 0, 640, 640);
    }
    canvas.setAttribute('aria-label', full ? `Full-photo reveal: ${name}` : `Clue ${stage + 1} of 5, answer hidden`);
    dialog.querySelector('.preview-caption strong').textContent = full ? name : `Clue ${stage + 1} of 5`;
    dialog.querySelector('.preview-caption p').textContent = full ? 'Full-photo reveal after a correct answer or five misses.' : stage ? `${stage} wrong ${stage === 1 ? 'guess' : 'guesses'} · the next view players see` : 'The first view players see';
    previous.disabled = stage === 0;
    next.textContent = full ? 'Restart ↺' : stage === 4 ? 'Fifth miss →' : 'Wrong guess →';
    reveal.hidden = full;
    [...steps.children].forEach((button, index) => button.setAttribute('aria-pressed', String(index === stage)));
  }
  previous.onclick = () => { stage = Math.max(0, stage - 1); paint(); };
  next.onclick = () => { stage = stage === 5 ? 0 : stage + 1; paint(); };
  reveal.onclick = () => { stage = 5; paint(); };
  dialog.querySelector('.admin-icon-button').onclick = closePuzzlePreview;
  dialog.addEventListener('close', () => { if (activePreview === dialog) activePreview = null; dialog.remove(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePuzzlePreview();
  });
  document.body.append(dialog);
  activePreview = dialog;
  paint();
  dialog.showModal();
}
