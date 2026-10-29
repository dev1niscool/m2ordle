import {MAX_GUESSES, namePicker, shareText, countdown} from './shared.js';

const app = document.querySelector('#app');
const apiBase = (window.M2ORDLE_CONFIG?.apiBase || '').replace(/\/$/, '');
const icons = {
  back:'<path d="m14 5-7 7 7 7M7 12h14"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>',
  help:'<path d="M9 9a3 3 0 1 1 5 2c-1 1-2 1-2 3M12 17v1"/><circle cx="12" cy="12" r="10"/>',
  stats:'<path d="M4 20V12h4v8m2 0V4h4v16m2 0V8h4v12"/>',
  trophy:'<path d="M7 3h10v6a5 5 0 0 1-10 0V3Zm5 11v6m-5 1h10M7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4"/>',
  copy:'<path d="M9 8h11v13H9zM15 8V3H4v13h5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
let token = '', people = [], game = null, screen = 'home', busy = false, imageUrl = null, generation = 0, navigation = 0, activeDialog = null, toastTimer;
let imageController = null, imageLoading = false, guessPicker = null;
try { token = localStorage.getItem('m2ordle-session') || ''; } catch {}

async function api(path, {body, auth = true, ...options} = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(apiBase + path, {...options, method: body === undefined ? 'GET' : 'POST', headers: {...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(auth && token ? {Authorization:`Bearer ${token}`} : {})}, body:body === undefined ? undefined : JSON.stringify(body), signal:controller.signal});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), {status:response.status});
    return data;
  } catch (error) { if (error.name === 'AbortError') throw new Error('The connection timed out. Please try again.'); throw error; }
  finally { clearTimeout(timeout); }
}
async function ensureSession() {
  if (!token) { const data = await api('/api/session', {body:{},auth:false}); token = data.token; try {localStorage.setItem('m2ordle-session',token);} catch {toast('Allow browser storage to keep your progress between visits.');} }
  if (!people.length) people = (await api('/api/roster', {auth:false})).people;
}
async function getGame() {
  await ensureSession();
  try { return await api('/api/game'); }
  catch(error) { if (error.status !== 401) throw error; token=''; await ensureSession(); return api('/api/game'); }
}
function toast(text) {
  const element=document.querySelector('#toast'); element.textContent=text; element.hidden=false;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>element.hidden=true,3500);
}
function updateGuessControls(){
  const form=app.querySelector('.guess-form');if(!form||!guessPicker)return;
  guessPicker.input.disabled=busy||imageLoading;
  form.querySelector('button').disabled=busy||imageLoading||!guessPicker.selected;
}
function setBusy(value){busy=value;updateGuessControls();}
function releaseImage(){
  imageController?.abort();imageController=null;
  if(imageUrl){URL.revokeObjectURL(imageUrl);imageUrl=null;}
}
function home() {
  navigation++;generation++;screen='home';guessPicker=null;imageLoading=false;setBusy(false);closeModal();releaseImage();
  app.innerHTML=`<section class="title-screen"><h1><img class="wordmark" src="./assets/m2ordle.svg?v=4" alt="M2ordle" width="700" height="180"></h1><p class="tagline">Guess the classmate</p><button class="play-button"><span class="play-icon" aria-hidden="true"></span>PLAY</button><nav class="home-nav" aria-label="Game information"><button class="text-button" data-action="help">${icon('help')}How to play</button><button class="text-button" data-action="stats">${icon('stats')}Stats</button><button class="text-button" data-action="leaders">${icon('trophy')}Leaderboard</button></nav></section>`;
  app.querySelector('.play-button').onclick=start;
  app.querySelector('[data-action=help]').onclick=help;
  app.querySelector('[data-action=stats]').onclick=showStats;
  app.querySelector('[data-action=leaders]').onclick=leaderboard;
}
function loading() {
  generation++;guessPicker=null;imageLoading=false;releaseImage();
  app.innerHTML='<section class="empty-screen" aria-live="polite"><div class="loader" aria-hidden="true"><i></i><i></i><i></i></div><p>Finding today’s M2ordle…</p></section>';
}
async function start() {
  if(busy)return;
  const currentNavigation=++navigation;
  setBusy(true);screen='game';loading();
  try {
    const next=await getGame();
    if(currentNavigation!==navigation||screen!=='game')return;
    game=next;await renderGame();
    if(currentNavigation!==navigation||screen!=='game')return;
    if(game.available&&game.status!=='playing')await results();
  }catch(error){if(currentNavigation===navigation&&screen==='game')errorScreen(error.message);}
  finally{if(currentNavigation===navigation)setBusy(false);}
}
function errorScreen(message) {
  generation++;guessPicker=null;imageLoading=false;releaseImage();
  app.innerHTML='<section class="empty-screen"><h1>One moment…</h1><p></p><button class="pixel-button primary" data-retry>TRY AGAIN</button><button class="text-button" data-home>Back to home</button></section>';
  app.querySelector('p').textContent=message;app.querySelector('[data-retry]').onclick=start;app.querySelector('[data-home]').onclick=home;
}
async function renderGame() {
  const thisGeneration=++generation;
  releaseImage();guessPicker=null;imageLoading=false;
  if(!game.available){
    app.innerHTML='<section class="empty-screen"><img class="wordmark" src="./assets/m2ordle.svg?v=4" alt="M2ordle"><div class="empty-icon" aria-hidden="true">＋</div><h1>Today’s frame is on its way.</h1><p>Check again, or contact Devin to update today’s M2ordle.</p><button class="pixel-button primary" data-retry>CHECK AGAIN</button><button class="text-button" data-home>Back to home</button></section>';
    app.querySelector('[data-retry]').onclick=start;app.querySelector('[data-home]').onclick=home;return;
  }
  const finished=game.status!=='playing';
  imageLoading=true;
  app.innerHTML=`<section class="game"><header class="game-header"><button class="icon-button" data-home aria-label="Back to home">${icon('back')}</button><img class="mini-logo" src="./assets/m2ordle.svg?v=4" alt="M2ordle"><button class="icon-button" data-help aria-label="How to play">${icon('help')}</button></header><div class="puzzle-label"><span data-number></span><span>DAILY CLASS PORTRAIT</span></div><div class="photo-frame loading"><img alt="${finished?'Today’s revealed class portrait':'A cropped detail of today’s classmate'}"></div><div class="play-area"></div><p class="feedback" role="status"></p><ol class="guess-history" aria-label="Your guesses"></ol></section>`;
  app.querySelector('[data-home]').onclick=home;app.querySelector('[data-help]').onclick=help;app.querySelector('[data-number]').textContent=`M2ORDLE #${game.number}`;
  const area=app.querySelector('.play-area');
  if(finished){
    const label=document.createElement('h1');label.className='finished-label';label.textContent=game.answer.name;
    const sub=document.createElement('p');sub.className='finished-sub';sub.textContent=game.status==='won'?`You found them in ${game.guesses.length}/5. +${game.points} ${game.points===1?'point':'points'}.`:'Five guesses down. A new classmate tomorrow.';
    const button=document.createElement('button');button.className='pixel-button primary wide';button.textContent='VIEW RESULTS';button.onclick=results;area.append(label,sub,button);
  }else{
    area.innerHTML='<div class="photo-caption"><div><h1>Who’s in the frame?</h1><p data-attempt></p></div><div class="guess-progress" aria-label="Guess progress"></div></div><form class="guess-form"><div data-picker></div><button type="submit" class="pixel-button primary" disabled>GUESS</button></form><p class="form-hint">Choose a name from the list. Each miss reveals a little more.</p>';
    area.querySelector('[data-attempt]').textContent=`Guess ${game.guesses.length+1} of 5`;
    const progress=area.querySelector('.guess-progress');
    for(let i=0;i<5;i++){const block=document.createElement('span');block.className=`guess-square ${i<game.guesses.length?'wrong':i===game.guesses.length?'current':''}`;progress.append(block);}
    const picker=namePicker(area.querySelector('[data-picker]'),people,{excluded:game.guesses.map(g=>g.personId),onSelect:updateGuessControls});
    guessPicker=picker;updateGuessControls();
    area.querySelector('form').onsubmit=event=>{event.preventDefault();if(picker.selected&&!busy&&!imageLoading)submitGuess(picker.selected);};
  }
  for(const [i,guess] of game.guesses.entries()){
    const li=document.createElement('li');li.className=guess.correct?'correct':'';
    const text=document.createElement('span'),num=document.createElement('span'),mark=document.createElement('span');num.className='guess-no';num.textContent=String(i+1).padStart(2,'0');text.append(num,document.createTextNode(guess.name));mark.className='outcome';mark.textContent=guess.correct?'✓':'×';mark.setAttribute('aria-label',guess.correct?'Correct':'Incorrect');li.append(text,mark);app.querySelector('.guess-history').append(li);
  }
  const controller=new AbortController();imageController=controller;
  const timeout=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(apiBase+game.image,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
    if(!response.ok)throw new Error('The photo could not load. Tap the frame to retry.');
    const blob=await response.blob();if(thisGeneration!==generation)return;
    imageUrl=URL.createObjectURL(blob);app.querySelector('.photo-frame img').src=imageUrl;app.querySelector('.photo-frame').classList.remove('loading');
  }catch(error){
    if(thisGeneration===generation){
      app.querySelector('.feedback').textContent=error.name==='AbortError'?'The photo took too long to load. Tap the frame to retry.':error.message;
      const frame=app.querySelector('.photo-frame');frame.setAttribute('role','button');frame.tabIndex=0;frame.setAttribute('aria-label','Retry loading photo');frame.onclick=renderGame;
      frame.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();renderGame();}};
    }
  }finally{
    clearTimeout(timeout);if(imageController===controller)imageController=null;
    if(thisGeneration===generation){imageLoading=false;updateGuessControls();}
  }
}
async function submitGuess(person) {
  const currentNavigation=navigation,prior=game.guesses.length;
  const submittedDate=game.date,requestId=crypto.randomUUID();
  setBusy(true);const button=app.querySelector('.guess-form button');button.textContent='…';
  try {
    const next=await api('/api/guess',{body:{personId:person.id,requestId,date:submittedDate}});
    if(currentNavigation!==navigation||screen!=='game')return;
    game=next;await renderGame();
    if(currentNavigation!==navigation||screen!=='game')return;
    if(game.status!=='playing')await results();
    else if(imageUrl){app.querySelector('.feedback').textContent='Not quite. New angle, a little further out.';}
  }catch(error){
    if(currentNavigation!==navigation||screen!=='game')return;
    // Reconcile with the server before accepting another guess: the original request may have succeeded.
    try{
      const next=await getGame();
      if(currentNavigation!==navigation||screen!=='game')return;
      game=next;await renderGame();
      if(currentNavigation!==navigation||screen!=='game'||!game.available)return;
      if(game.status!=='playing')await results();
      else{const feedback=app.querySelector('.feedback');if(feedback&&imageUrl)feedback.textContent=game.date!==submittedDate?'A new M2ordle has started.':game.guesses.length>prior?'Your guess was saved. Try the new crop.':error.message;}
    }catch{if(currentNavigation===navigation&&screen==='game')errorScreen('We couldn’t confirm that guess. Reconnect to restore your saved progress.');}
  }finally{
    if(currentNavigation===navigation){setBusy(false);if(screen==='game')guessPicker?.input.focus();}
  }
}

function closeModal(){if(activeDialog){activeDialog.close();activeDialog.remove();activeDialog=null;}}
function modal(title){
  closeModal();const dialog=document.createElement('dialog');
  dialog.innerHTML=`<div class="modal-top"><h2></h2><button class="icon-button" aria-label="Close">${icon('close')}</button></div><div class="modal-body"></div>`;
  dialog.querySelector('h2').textContent=title;dialog.querySelector('button').onclick=closeModal;
  dialog.addEventListener('close',()=>{dialog.remove();if(activeDialog===dialog)activeDialog=null;});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}});
  document.body.append(dialog);activeDialog=dialog;dialog.showModal();return dialog.querySelector('.modal-body');
}
function help(){
  const body=modal('HOW TO PLAY');
  body.innerHTML='<ol class="help-list"><li>One classmate, hidden in a close-up portrait. You have <strong>five guesses</strong>.</li><li>Start typing a name and select a classmate from the list.</li><li>A wrong guess zooms out and shifts to a new part of the photo.</li><li>Solve the frame, share your squares, and add your points to the class leaderboard.</li></ol><p class="help-note">A new M2ordle arrives at midnight Central Time.<br><br>1st guess = 5 points · 2nd = 4 · 3rd = 3 · 4th = 2 · 5th = 1. An unsolved puzzle earns 0 points.</p><button class="pixel-button primary wide">GOT IT</button>';
  body.querySelector('button').onclick=closeModal;
}
function statsMarkup(body,stats){
  const summary=document.createElement('div');summary.className='stats-summary';
  for(const [value,label] of [[stats.played,'PLAYED'],[stats.played?Math.round(stats.wins/stats.played*100):0,'WIN %'],[stats.streak,'STREAK']]){const stat=document.createElement('div');stat.className='stat';const strong=document.createElement('strong');strong.textContent=value;const small=document.createElement('small');small.textContent=label;stat.append(strong,small);summary.append(stat);}body.append(summary);
  const distribution=document.createElement('section');distribution.className='distribution';distribution.innerHTML='<div class="distribution-heading"><h3>GUESS DISTRIBUTION</h3><select class="distribution-select" aria-label="Distribution type"><option value="today">Class today</option><option value="personal">My history</option></select></div><div class="dist-rows"></div><p class="distribution-note"></p>';body.append(distribution);
  function paint(){
    const today=distribution.querySelector('select').value==='today';const counts=today?stats.todayDistribution:stats.distribution;const max=Math.max(1,...counts);const rows=distribution.querySelector('.dist-rows');rows.replaceChildren();
    for(let i=0;i<5;i++){const row=document.createElement('div');row.className='dist-row';const label=document.createElement('span');label.textContent=i+1;const track=document.createElement('div');track.className='dist-track';const bar=document.createElement('span');bar.className='dist-bar'+(game?.status==='won'&&game.guesses.length===i+1?' highlight':'');bar.style.width=`${Math.max(6,counts[i]/max*100)}%`;bar.textContent=counts[i];track.append(bar);row.append(label,track);rows.append(row);}
    distribution.querySelector('.distribution-note').textContent=today?`${stats.todayFailed} unsolved today · completed games across the class`:'Your completed games on this browser.';
  }
  distribution.querySelector('select').onchange=paint;paint();
}
async function showStats(){
  const body=modal('YOUR STATS');body.innerHTML='<p class="identity-copy">Loading your stats…</p>';
  try{await ensureSession();const stats=await api('/api/stats');if(!body.isConnected)return;body.replaceChildren();statsMarkup(body,stats);const note=document.createElement('p');note.className='help-note';note.textContent=`Best streak: ${stats.maxStreak} days. Progress is linked to this browser. Add each result to the leaderboard to keep your class points under your name.`;body.append(note);}catch(error){body.textContent=error.message;}
}
async function results(){
  if(!game?.available||game.status==='playing')return;
  const body=modal(`M2ORDLE #${game.number}`);
  body.innerHTML='<div class="result-hero"><p class="result-kicker"></p><h3></h3><p class="result-answer"></p><div class="result-score"></div><div class="result-squares" aria-label="Share result"></div></div><div data-stats><p class="identity-copy">Loading stats…</p></div><div class="result-bottom"><div class="reset-clock"><small>NEXT M2ORDLE · MIDNIGHT CT</small><strong data-countdown></strong></div><button class="pixel-button primary share-button">'+icon('copy')+'COPY</button></div><div data-claim></div>';
  const won=game.status==='won';body.querySelector('.result-kicker').textContent=won?`+${game.points} ${game.points===1?'POINT':'POINTS'}`:'ANOTHER FRAME TOMORROW';body.querySelector('h3').textContent=won?'Nice, you got it!':'That was a tough one.';body.querySelector('.result-answer').textContent=game.answer.name;body.querySelector('.result-score').append(document.createTextNode(won?game.guesses.length:'X'));const outOf=document.createElement('span');outOf.textContent=' / 5';body.querySelector('.result-score').append(outOf);
  for(let i=0;i<5;i++){const square=document.createElement('i');square.className=game.guesses[i]?(game.guesses[i].correct?'correct':'wrong'):'';body.querySelector('.result-squares').append(square);}
  body.querySelector('[data-countdown]').textContent=countdown(game.nextReset);body.querySelector('.share-button').onclick=()=>copyResult(body);
  const claim=body.querySelector('[data-claim]');
  if(game.claimed){const note=document.createElement('p');note.className='claim-note';note.textContent=`✓ Added as ${game.claimed.name}`;claim.append(note);const button=document.createElement('button');button.className='text-button back-link';button.textContent='View leaderboard →';button.onclick=leaderboard;claim.append(button);}
  else{const button=document.createElement('button');button.className='pixel-button wide claim-button';button.innerHTML=icon('trophy')+'ADD TO LEADERBOARD';button.onclick=identity;claim.append(button);}
  try{const stats=await api('/api/stats');if(!body.isConnected)return;body.querySelector('[data-stats]').replaceChildren();statsMarkup(body.querySelector('[data-stats]'),stats);}catch{if(body.isConnected)body.querySelector('[data-stats]').textContent='Stats are temporarily unavailable.';}
}
async function copyResult(body){
  const text=shareText(game),button=body.querySelector('.share-button');
  try{await navigator.clipboard.writeText(text);button.innerHTML=icon('copy')+'COPIED!';setTimeout(()=>{if(button.isConnected)button.innerHTML=icon('copy')+'COPY';},2500);}
  catch{let area=body.querySelector('.copy-fallback');if(!area){area=document.createElement('textarea');area.className='copy-fallback';area.readOnly=true;area.setAttribute('aria-label','Result text to copy');body.append(area);}area.value=text;area.focus();area.select();toast('Select and copy your result below.');}
}
function identity(){
  const body=modal('ADD YOUR RESULT');body.innerHTML='<p class="identity-copy">Choose your name to add this result to your cumulative class score.</p><form class="identity-form"><div data-identity></div><button class="pixel-button primary wide" disabled>CONTINUE</button></form><button class="text-button back-link">← Back to results</button>';
  const button=body.querySelector('form button');const picker=namePicker(body.querySelector('[data-identity]'),people,{label:'Your name',placeholder:'Find your name…',onSelect:p=>button.disabled=!p});body.querySelector('form').onsubmit=e=>{e.preventDefault();if(picker.selected)verifyIdentity(picker.selected);};body.querySelector('.back-link').onclick=results;picker.input.focus();
}
function verifyIdentity(person){
  const body=modal('CONFIRM YOUR IDENTITY');body.innerHTML='<p class="identity-copy"></p><form class="identity-form"><div><label for="table-number">What table number are you?</label><input id="table-number" name="table" type="text" inputmode="numeric" pattern="[0-9]{1,3}" maxlength="3" autocomplete="off" required placeholder="Your table number"></div><p class="feedback" role="alert"></p><button class="pixel-button primary wide">CONFIRM & ADD RESULT</button></form><button class="text-button back-link">← Choose a different name</button>';
  body.querySelector('.identity-copy').textContent=`Hi, ${person.name}. Enter your assigned class table number to confirm this result is yours.`;body.querySelector('.back-link').onclick=identity;
  body.querySelector('form').onsubmit=async e=>{
    e.preventDefault();const button=body.querySelector('form button');if(button.disabled)return;
    const currentNavigation=navigation,claimDate=game.date;
    button.disabled=true;button.textContent='CHECKING…';
    try{
      const updated=await api('/api/claim',{body:{personId:person.id,table:body.querySelector('input').value,date:claimDate}});
      if(currentNavigation!==navigation||game?.date!==claimDate)return;
      game=updated;if(!body.isConnected)return;
      toast('Your result is on the leaderboard!');await results();
    }catch(error){if(body.isConnected&&currentNavigation===navigation){body.querySelector('.feedback').textContent=error.message;button.disabled=false;button.textContent='CONFIRM & ADD RESULT';}}
  };body.querySelector('input').focus();
}
async function leaderboard(){
  const body=modal('CLASS LEADERBOARD');body.innerHTML='<p class="leaderboard-intro">Every M2ordle counts. Earn 5 points for a first-guess solve, down to 1 point on guess five.</p><p class="identity-copy" data-loading>Loading the class standings…</p>';
  try{const data=await api('/api/leaderboard',{auth:false});if(!body.isConnected)return;body.querySelector('[data-loading]').remove();
    if(!data.entries.length){const empty=document.createElement('p');empty.className='leaderboard-empty';empty.textContent='A fresh start for the class. Finish a puzzle and add your result to claim the first spot.';body.append(empty);return;}
    const table=document.createElement('table');table.className='leaderboard-table';table.innerHTML='<thead><tr><th scope="col">#</th><th scope="col">CLASSMATE</th><th scope="col">WINS</th><th scope="col">PTS</th></tr></thead><tbody></tbody>';
    for(const entry of data.entries){const row=document.createElement('tr');for(const [value,cls] of [[entry.rank,''],[entry.name,''],[entry.wins,''],[entry.points,'points']]){const cell=document.createElement('td');cell.textContent=value;cell.className=cls;row.append(cell);}table.querySelector('tbody').append(row);}body.append(table);const note=document.createElement('p');note.className='help-note';note.textContent='Ties break by wins, then average guesses. One verified result per classmate per day.';body.append(note);
  }catch(error){if(body.isConnected)body.querySelector('[data-loading]').textContent=error.message;}
}
async function checkReset(){
  if(!game||busy)return;
  if(Date.now()>=new Date(game.nextReset).getTime()&&screen==='game') {closeModal();game=null;await start();}
}
setInterval(()=>{document.querySelectorAll('[data-countdown]').forEach(el=>{if(game)el.textContent=countdown(game.nextReset);});checkReset();},1000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkReset();});
home();
