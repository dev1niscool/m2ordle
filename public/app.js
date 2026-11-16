import {MAX_GUESSES, namePicker, shareText, countdown} from './shared.js?v=17';
import {classmates} from './classmates.js?v=11';

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
const people = classmates;
let token = '', game = null, screen = 'home', busy = false, imageUrl = null, generation = 0, navigation = 0, activeDialog = null, toastTimer;
let imageController = null, imageLoading = false, guessPicker = null;
const ARCHIVE_START = '2026-11-19';
const centralFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'});
const archiveDateFormatter = new Intl.DateTimeFormat('en-US', {timeZone:'UTC',month:'short',day:'numeric',year:'numeric'});
let siteStatus = null, checkingStatus = false, checkedLocalDate = '', statusRetryAfter = 0;
function localCentralDate(){const parts=Object.fromEntries(centralFormatter.formatToParts(new Date()).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;}
function archiveMode(){return siteStatus?.mode==='archive';}
function formatPuzzleDate(date){return archiveDateFormatter.format(new Date(date+'T12:00:00Z'));}
async function refreshStatus(){
  try{siteStatus=await api('/api/status',{auth:false});statusRetryAfter=0;}
  catch{const date=localCentralDate();siteStatus={date,mode:siteStatus?.mode==='archive'||date>=ARCHIVE_START?'archive':'daily',archiveStarts:ARCHIVE_START,nextReset:null};statusRetryAfter=Date.now()+60000;}
  checkedLocalDate=localCentralDate();return siteStatus;
}
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
}
async function sessionApi(path, options) {
  await ensureSession();
  try {return await api(path,options);}
  catch(error){if(error.status!==401)throw error;token='';await ensureSession();return api(path,options);}
}
async function getGame(replayId) {return sessionApi(replayId?'/api/archive/game?replayId='+encodeURIComponent(replayId):'/api/game');}
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
function releaseGuessPicker(){guessPicker?.destroy();guessPicker=null;}
function home() {
  navigation++;generation++;screen='home';releaseGuessPicker();imageLoading=false;setBusy(false);closeModal();releaseImage();
  window.scrollTo(0,0);
  if(archiveMode()){renderArchiveHome(navigation);return;}
  app.innerHTML=`<section class="title-screen"><h1><img class="wordmark" src="./assets/m2ordle.svg?v=13" alt="M2ordle" width="700" height="180"></h1><p class="tagline">Guess the classmate</p><button class="play-button"><span class="play-icon" aria-hidden="true"></span>PLAY</button><nav class="home-nav" aria-label="Game information"><button class="text-button" data-action="help">${icon('help')}How to play</button><button class="text-button" data-action="stats">${icon('stats')}Stats</button><button class="text-button" data-action="leaders">${icon('trophy')}Leaderboard</button></nav></section>`;
  app.querySelector('.play-button').onclick=start;
  app.querySelector('[data-action=help]').onclick=help;
  app.querySelector('[data-action=stats]').onclick=showStats;
  app.querySelector('[data-action=leaders]').onclick=leaderboard;
}
function loading(message='Finding today’s M2ordle…') {
  generation++;releaseGuessPicker();imageLoading=false;releaseImage();
  app.innerHTML='<section class="empty-screen" aria-live="polite"><div class="loader" aria-hidden="true"><i></i><i></i><i></i></div><p></p></section>';
  app.querySelector('p').textContent=message;
}
async function start() {
  if(busy)return;
  if(archiveMode()){home();return;}
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
function errorScreen(message,retry=start) {
  generation++;releaseGuessPicker();imageLoading=false;releaseImage();
  app.innerHTML='<section class="empty-screen"><h1>One moment…</h1><p></p><button class="pixel-button primary" data-retry>TRY AGAIN</button><button class="text-button" data-home>Back to home</button></section>';
  app.querySelector('p').textContent=message;app.querySelector('[data-retry]').onclick=retry;app.querySelector('[data-home]').onclick=home;
}
async function renderGame() {
  const thisGeneration=++generation;
  releaseImage();releaseGuessPicker();imageLoading=false;
  if(!game.available){
    if(game.reason==='study'){siteStatus={...siteStatus,mode:'archive',date:game.date,nextReset:game.nextReset};home();return;}
    app.innerHTML='<section class="empty-screen"><img class="wordmark" src="./assets/m2ordle.svg?v=13" alt="M2ordle"><div class="empty-icon" aria-hidden="true">＋</div><h1></h1><p></p><button class="pixel-button primary" data-retry>CHECK AGAIN</button><button class="text-button" data-home>Back to home</button></section>';
    app.querySelector('h1').textContent=game.reason==='weekend'?'M2ordle is closed for the weekend.':'Today’s frame is on its way.';
    app.querySelector('p').textContent=game.message||'Check again, or contact Devin to update today’s M2ordle.';
    app.querySelector('[data-retry]').onclick=start;app.querySelector('[data-home]').onclick=home;return;
  }
  const finished=game.status!=='playing',factsClue=!finished&&game.clue?.type==='facts';
  imageLoading=!factsClue;
  app.innerHTML=`<section class="game"><header class="game-header"><button class="icon-button" data-home aria-label="${game.replay?'Back to past M2ordles':'Back to home'}">${icon('back')}</button><img class="mini-logo" src="./assets/m2ordle.svg?v=13" alt="M2ordle"><button class="icon-button" data-help aria-label="How to play">${icon('help')}</button></header><div class="puzzle-label"><span data-number></span><span>${game.replay?'PRACTICE REPLAY':'DAILY CLASSMATE'}</span></div><div class="photo-frame ${factsClue?'fact-frame':'loading'}">${factsClue?'<section class="fact-card" aria-label="Lookbook clues"><p class="fact-kicker"></p><ol class="fact-list"></ol></section>':`<img alt="${finished?'The revealed class portrait':'A cropped detail of the classmate'}">`}</div><div class="play-area"></div><p class="feedback" role="status"></p><ol class="guess-history" aria-label="Your guesses"></ol></section>`;
  app.querySelector('[data-home]').onclick=game.replay?archive:home;app.querySelector('[data-help]').onclick=help;app.querySelector('[data-number]').textContent=`M2ORDLE #${game.number}`;
  if(factsClue){
    const facts=game.clue.facts,card=app.querySelector('.fact-card');
    card.classList.toggle('single',facts.length===1);
    card.querySelector('.fact-kicker').textContent=facts.length===1?'LOOKBOOK · ONE FUN FACT':'LOOKBOOK · THREE FUN FACTS';
    for(const fact of facts){const item=document.createElement('li');item.textContent=fact;card.querySelector('.fact-list').append(item);}
  }
  if(game.replay){const note=document.createElement('p');note.className='replay-note';note.textContent=formatPuzzleDate(game.date)+' · Practice only';app.querySelector('.puzzle-label').after(note);}
  const area=app.querySelector('.play-area');
  if(finished){
    const label=document.createElement('h1');label.className='finished-label';label.textContent=game.answer.name;
    const sub=document.createElement('p');sub.className='finished-sub';sub.textContent=game.replay?(game.status==='won'?`You found them in ${game.guesses.length}/5. Replay complete!`:'Five guesses down. Try another past M2ordle.'):(game.status==='won'?`You found them in ${game.guesses.length}/5. +${game.points} ${game.points===1?'point':'points'}.`:(game.date==='2026-11-18'?'Five guesses down. Thanks for playing!':'Five guesses down. A new classmate tomorrow.'));
    const button=document.createElement('button');button.className='pixel-button primary wide';button.textContent='VIEW RESULTS';button.onclick=results;area.append(label,sub,button);
  }else{
    area.innerHTML='<div class="photo-caption"><div><h1></h1><p data-attempt></p></div><div class="guess-progress" aria-label="Guess progress"></div></div><form class="guess-form"><div data-picker></div><button type="submit" class="pixel-button primary" disabled>GUESS</button></form><p class="form-hint">Choose a name from the list. Each miss reveals a little more.</p>';
    area.querySelector('h1').textContent=factsClue?'Who’s this classmate?':'Who’s in the frame?';
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
  if(factsClue)return;
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
  const currentNavigation=navigation,prior=game.guesses.length,previousWasFacts=game.clue?.type==='facts';
  const submittedDate=game.date,replayId=game.replayId,requestId=crypto.randomUUID();
  setBusy(true);const button=app.querySelector('.guess-form button');button.textContent='…';
  try {
    const next=await api(replayId?'/api/archive/guess':'/api/guess',{body:{personId:person.id,requestId,...(replayId?{replayId}:{date:submittedDate})}});
    if(currentNavigation!==navigation||screen!=='game')return;
    game=next;await renderGame();
    if(currentNavigation!==navigation||screen!=='game')return;
    if(game.status!=='playing')await results();
    else if(game.clue?.type==='facts'){app.querySelector('.feedback').textContent='Not quite. Here are all three fun facts.';}
    else if(imageUrl){app.querySelector('.feedback').textContent=previousWasFacts?'Not quite. Here’s your first photo clue.':'Not quite. New angle, a little further out.';}
  }catch(error){
    if(currentNavigation!==navigation||screen!=='game')return;
    // Reconcile with the server before accepting another guess: the original request may have succeeded.
    try{
      const next=await getGame(replayId);
      if(currentNavigation!==navigation||screen!=='game')return;
      game=next;await renderGame();
      if(currentNavigation!==navigation||screen!=='game'||!game.available)return;
      if(game.status!=='playing')await results();
      else{const feedback=app.querySelector('.feedback');if(feedback&&(imageUrl||game.clue?.type==='facts'))feedback.textContent=game.date!==submittedDate?'A new M2ordle has started.':game.guesses.length>prior?'Your guess was saved. Try the new clue.':error.message;}
    }catch{if(currentNavigation===navigation&&screen==='game')errorScreen('We couldn’t confirm that guess. Reconnect to restore your saved progress.',replayId?()=>startReplay(submittedDate):start);}
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
  body.innerHTML='<ol class="help-list"><li>Guess the classmate in <strong>five guesses</strong>.</li><li>Lookbook puzzles start with one fun fact, then all three facts after a miss. Guesses 3–5 reveal three photo crops.</li><li>Other puzzles start with a close-up portrait. Each wrong guess reveals a wider crop.</li><li>Start typing a name and choose a classmate from the list. Share your squares and add your points to the class leaderboard when you finish.</li></ol><p class="help-note">A new M2ordle arrives at midnight Central Time. Unpublished weekends preserve your streak.<br><br>1st guess = 5 points · 2nd = 4 · 3rd = 3 · 4th = 2 · 5th = 1. An unsolved puzzle earns 0 points.</p><button class="pixel-button primary wide">GOT IT</button>';
  if(archiveMode()){body.querySelector('.help-list li:last-child').textContent='Start typing a name and choose a classmate from the list. Replay any past puzzle as often as you like.';body.querySelector('.help-note').textContent='Daily M2ordles ended for the Step 1 study period on November 19. Replays are just for fun and leave the class leaderboard, your stats, and your streak unchanged.';}
  body.querySelector('button').onclick=closeModal;
}
function statsMarkup(body,stats,distributionTarget=body){
  const summary=document.createElement('div');summary.className='stats-summary';
  for(const [value,label] of [[stats.played,'PLAYED'],[stats.played?Math.round(stats.wins/stats.played*100):0,'WIN %'],[stats.streak,'STREAK']]){const stat=document.createElement('div');stat.className='stat';const strong=document.createElement('strong');strong.textContent=value;const small=document.createElement('small');small.textContent=label;stat.append(strong,small);summary.append(stat);}body.append(summary);
  const distribution=document.createElement('section');distribution.className='distribution';distribution.innerHTML='<div class="distribution-heading"><h3>GUESS DISTRIBUTION</h3><select class="distribution-select" aria-label="Distribution type"><option value="today">Class today</option><option value="personal">My history</option></select></div><div class="dist-rows"></div><p class="distribution-note"></p>';distributionTarget.append(distribution);
  function paint(){
    const today=distribution.querySelector('select').value==='today';const counts=today?stats.todayDistribution:stats.distribution;const max=Math.max(1,...counts);const rows=distribution.querySelector('.dist-rows');rows.replaceChildren();
    for(let i=0;i<5;i++){const row=document.createElement('div');row.className='dist-row';const label=document.createElement('span');label.textContent=i+1;const track=document.createElement('div');track.className='dist-track';const bar=document.createElement('span');bar.className='dist-bar'+(game?.status==='won'&&!game.replay&&game.guesses.length===i+1?' highlight':'');bar.style.width=`${Math.max(6,counts[i]/max*100)}%`;bar.textContent=counts[i];track.append(bar);row.append(label,track);rows.append(row);}
    distribution.querySelector('.distribution-note').textContent=today?`${stats.todayFailed} unsolved today · completed games across the class`:'Your completed games on this browser.';
  }
  if(archiveMode()){distribution.querySelector('select').value='personal';distribution.querySelector('option[value=today]').remove();}
  distribution.querySelector('select').onchange=paint;paint();
}
async function showStats(){
  const body=modal('YOUR STATS');body.innerHTML='<p class="identity-copy">Loading your stats…</p>';
  try{await ensureSession();const stats=await api('/api/stats');if(!body.isConnected)return;body.replaceChildren();statsMarkup(body,stats);const note=document.createElement('p');note.className='help-note';note.textContent=archiveMode()?`Best streak: ${stats.maxStreak} days. These are your original daily results on this browser. Replays leave them unchanged.`:`Best streak: ${stats.maxStreak} days. Progress is linked to this browser. Add each result to the leaderboard to keep your class points under your name.`;body.append(note);}catch(error){body.textContent=error.message;}
}
async function results(){
  if(!game?.available||game.status==='playing')return;
  if(game.replay){replayResults();return;}
  const body=modal(`M2ORDLE #${game.number}`);
  body.innerHTML='<div class="result-hero"><p class="result-kicker"></p><h3></h3><p class="result-answer"></p><div class="result-score"></div><div class="result-squares" aria-label="Share result"></div></div><div data-stats><p class="identity-copy">Loading stats…</p></div><div data-claim></div><div class="result-bottom"><div class="reset-clock"><small>NEXT M2ORDLE · MIDNIGHT CT</small><strong data-countdown></strong></div><button class="pixel-button primary share-button">'+icon('copy')+'COPY</button></div><div data-distribution></div>';
  const won=game.status==='won';body.querySelector('.result-kicker').textContent=won?`+${game.points} ${game.points===1?'POINT':'POINTS'}`:(game.date==='2026-11-18'?'THANKS FOR PLAYING':'ANOTHER FRAME TOMORROW');body.querySelector('h3').textContent=won?'Nice, you got it!':'That was a tough one.';body.querySelector('.result-answer').textContent=game.answer.name;body.querySelector('.result-score').append(document.createTextNode(won?game.guesses.length:'X'));const outOf=document.createElement('span');outOf.textContent=' / 5';body.querySelector('.result-score').append(outOf);
  for(let i=0;i<5;i++){const square=document.createElement('i');square.className=game.guesses[i]?(game.guesses[i].correct?'correct':'wrong'):'';body.querySelector('.result-squares').append(square);}
  if(game.date==='2026-11-18')body.querySelector('.reset-clock small').textContent='CLASS FINALE · MIDNIGHT CT';
  body.querySelector('[data-countdown]').textContent=countdown(game.nextReset);body.querySelector('.share-button').onclick=()=>copyResult(body);
  const claim=body.querySelector('[data-claim]');
  if(game.claimed){const note=document.createElement('p');note.className='claim-note';note.textContent=`✓ Added as ${game.claimed.name}`;claim.append(note);const button=document.createElement('button');button.className='text-button back-link';button.textContent='View leaderboard →';button.onclick=leaderboard;claim.append(button);}
  else{const button=document.createElement('button');button.className='pixel-button wide claim-button';button.innerHTML=icon('trophy')+'<span>Add to classwide leaderboard</span>';button.onclick=identity;claim.append(button);}
  try{const stats=await api('/api/stats');if(!body.isConnected)return;body.querySelector('[data-stats]').replaceChildren();statsMarkup(body.querySelector('[data-stats]'),stats,body.querySelector('[data-distribution]'));}catch{if(body.isConnected)body.querySelector('[data-stats]').textContent='Stats are temporarily unavailable.';}
}
async function copyResult(body){
  const text=shareText(game),button=body.querySelector('.share-button');
  try{await navigator.clipboard.writeText(text);button.innerHTML=icon('copy')+'COPIED!';setTimeout(()=>{if(button.isConnected)button.innerHTML=icon('copy')+'COPY';},2500);}
  catch{let area=body.querySelector('.copy-fallback');if(!area){area=document.createElement('textarea');area.className='copy-fallback';area.readOnly=true;area.setAttribute('aria-label','Result text to copy');body.querySelector('.result-bottom').after(area);}area.value=text;area.focus();area.select();toast('Select and copy your result below.');}
}
function identity(){
  const body=modal('ADD YOUR RESULT');body.innerHTML='<p class="identity-copy">Choose your name, then verify your table number to add your result to the classwide leaderboard.</p><form class="identity-form"><div data-identity></div><button class="pixel-button primary wide" disabled>CONTINUE</button></form><button class="text-button back-link">← Back to results</button>';
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
      toast('Your result is on the leaderboard!');await leaderboard();
    }catch(error){if(body.isConnected&&currentNavigation===navigation){body.querySelector('.feedback').textContent=error.message;button.disabled=false;button.textContent='CONFIRM & ADD RESULT';}}
  };body.querySelector('input').focus();
}
function appendStandings(container,entries,{scrollToYou=true}={}){
  if(!entries.length){const empty=document.createElement('p');empty.className='leaderboard-empty';empty.textContent=archiveMode()?'No verified scores were added this season. You can still explore the past puzzles.':'A fresh start for the class. Finish a puzzle and add your result to claim the first spot.';container.append(empty);return;}
  const standings=document.createElement('div');standings.className='leaderboard-scroll';standings.tabIndex=0;standings.setAttribute('role','region');standings.setAttribute('aria-label','Classwide leaderboard standings');
  const table=document.createElement('table');table.className='leaderboard-table';table.innerHTML='<thead><tr><th scope="col">#</th><th scope="col">CLASSMATE</th><th scope="col">WINS</th><th scope="col">PTS</th></tr></thead><tbody></tbody>';
  let yourRow=null;
  for(const entry of entries){
    const row=document.createElement('tr');
    for(const [value,cls] of [[entry.rank,''],[entry.name,'name'],[entry.wins,''],[entry.points,'points']]){const cell=document.createElement('td');cell.textContent=value;cell.className=cls;row.append(cell);}
    if(entry.isYou){row.className='is-you';row.setAttribute('aria-current','true');yourRow=row;const badge=document.createElement('span');badge.className='leaderboard-you';badge.textContent='YOU';row.querySelector('.name').append(document.createTextNode(' '),badge);}
    table.querySelector('tbody').append(row);
  }
  standings.append(table);container.append(standings);
  const note=document.createElement('p');note.className='standings-note';note.textContent='Ranked by total points. Ties break by wins, then average guesses.';container.append(note);
  if(scrollToYou)requestAnimationFrame(()=>{
    if(!yourRow?.isConnected)return;
    const row=yourRow.getBoundingClientRect(),frame=standings.getBoundingClientRect(),headerHeight=table.tHead.getBoundingClientRect().height;
    standings.scrollTop+=row.top-frame.top-standings.clientTop-headerHeight-(standings.clientHeight-headerHeight-row.height)/2;
  });
}
async function leaderboard(){
  const body=modal('CLASS LEADERBOARD');body.innerHTML='<p class="leaderboard-intro"></p><p class="identity-copy" data-loading>Loading the class standings…</p>';
  body.querySelector('.leaderboard-intro').textContent=archiveMode()?'The final class standings. Thanks for playing!':'Every M2ordle counts. Earn 5 points for a first-guess solve, down to 1 point on guess five.';
  try{const data=await api('/api/leaderboard');if(!body.isConnected)return;body.querySelector('[data-loading]').remove();body.closest('dialog').classList.add('leaderboard-dialog');appendStandings(body,data.entries);}
  catch(error){if(body.isConnected)body.querySelector('[data-loading]').textContent=error.message;}
}
function renderPodium(container,entries){
  container.replaceChildren();
  if(!entries.length)return;
  const list=document.createElement('ol');list.className='podium';list.setAttribute('aria-label','Top three classmates');
  for(const entry of entries.slice(0,3)){
    const place=document.createElement('li');place.className='podium-place place-'+entry.rank;
    const crown=document.createElement('span');crown.className='podium-medal';crown.setAttribute('aria-hidden','true');crown.innerHTML=icon('trophy');
    const name=document.createElement('strong');name.className='podium-name';name.textContent=entry.name;
    const points=document.createElement('span');points.className='podium-points';points.textContent=entry.points+' points';
    const step=document.createElement('span');step.className='podium-step';step.textContent=entry.rank;step.setAttribute('aria-label','Rank '+entry.rank);
    place.append(crown,name,points,step);list.append(place);
  }
  container.append(list);
}
async function renderArchiveHome(currentNavigation){
  app.innerHTML=`<section class="season-home"><header class="season-header"><img class="wordmark" src="./assets/m2ordle.svg?v=13" alt="M2ordle" width="700" height="180"><p class="season-kicker">THE CLASS LEADERBOARD</p><h1>One class. A lot of great guesses.</h1><p>M2ordle puzzles are closed for dedicated,<br>good luck on step!</p></header><section class="podium-section" aria-label="Top three guessers"><div data-podium></div></section><section class="season-standings" aria-labelledby="standings-title"><h2 id="standings-title">CLASSWIDE LEADERBOARD</h2><div data-standings><p class="identity-copy" role="status">Loading the class standings…</p></div></section><div class="archive-callout"><button class="play-button" data-archive><span class="play-icon" aria-hidden="true"></span>Play past M2ordles</button><p>Revisit the clues. Keep your original scores.</p></div><nav class="home-nav" aria-label="Game information"><button class="text-button" data-help>${icon('help')}How to play</button><button class="text-button" data-stats>${icon('stats')}My stats</button></nav></section>`;
  app.querySelector('[data-archive]').onclick=archive;app.querySelector('[data-help]').onclick=help;app.querySelector('[data-stats]').onclick=showStats;
  try{
    const data=await api('/api/leaderboard');if(currentNavigation!==navigation||screen!=='home')return;
    renderPodium(app.querySelector('[data-podium]'),data.entries);const target=app.querySelector('[data-standings]');target.replaceChildren();appendStandings(target,data.entries);
  }catch(error){if(currentNavigation!==navigation||screen!=='home')return;const target=app.querySelector('[data-standings]');target.replaceChildren();const message=document.createElement('p');message.className='identity-copy';message.textContent=error.message;const retry=document.createElement('button');retry.className='pixel-button';retry.textContent='RETRY LEADERBOARD';retry.onclick=()=>renderArchiveHome(currentNavigation);target.append(message,retry);}
}
async function archive(){
  const currentNavigation=++navigation;generation++;screen='archive';releaseGuessPicker();imageLoading=false;setBusy(false);closeModal();releaseImage();window.scrollTo(0,0);
  app.innerHTML=`<section class="archive-screen"><header class="game-header"><button class="icon-button" data-home aria-label="Back to leaderboard">${icon('back')}</button><img class="mini-logo" src="./assets/m2ordle.svg?v=13" alt="M2ordle"><button class="icon-button" data-help aria-label="How to play">${icon('help')}</button></header><div class="archive-heading"><p class="season-kicker">THE M2ORDLE ARCHIVE</p><h1>Play past M2ordles</h1><p>Pick a day. Five guesses, just for fun.<br>Replays leave your scores and streak unchanged.</p></div><div data-archive-list aria-live="polite"><p class="identity-copy">Finding past puzzles…</p></div></section>`;
  app.querySelector('[data-home]').onclick=home;app.querySelector('[data-help]').onclick=help;
  try{
    const data=await api('/api/archive');if(currentNavigation!==navigation||screen!=='archive')return;
    const target=app.querySelector('[data-archive-list]');target.replaceChildren();
    if(!data.entries.length){const empty=document.createElement('p');empty.className='leaderboard-empty';empty.textContent='No past puzzles are available yet.';target.append(empty);return;}
    const list=document.createElement('ul');list.className='archive-list';
    for(const entry of data.entries){
      const item=document.createElement('li'),button=document.createElement('button');button.className='archive-puzzle';
      const info=document.createElement('span');info.className='archive-puzzle-info';
      const number=document.createElement('strong');number.textContent='M2ordle #'+entry.number;
      const date=document.createElement('time');date.dateTime=entry.date;date.textContent=formatPuzzleDate(entry.date);
      const type=document.createElement('small');type.textContent=entry.clueType==='facts'?'Fun facts + photo clues':'Photo clues';
      const arrow=document.createElement('span');arrow.className='archive-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='→';
      info.append(number,date,type);button.append(info,arrow);button.onclick=()=>startReplay(entry.date);item.append(button);list.append(item);
    }
    target.append(list);
  }catch(error){if(currentNavigation===navigation&&screen==='archive')errorScreen(error.message,archive);}
}
async function startReplay(date,restart=false){
  if(busy)return;
  const currentNavigation=++navigation;setBusy(true);screen='game';closeModal();loading('Opening your past M2ordle…');window.scrollTo(0,0);
  try{
    const next=await sessionApi('/api/archive/start',{body:{date,restart}});
    if(currentNavigation!==navigation||screen!=='game')return;
    game=next;await renderGame();if(currentNavigation!==navigation||screen!=='game')return;
    if(game.available&&game.status!=='playing')await results();
  }catch(error){if(currentNavigation===navigation&&screen==='game')errorScreen(error.message,()=>startReplay(date));}
  finally{if(currentNavigation===navigation)setBusy(false);}
}
function replayResults(){
  const body=modal(`M2ORDLE #${game.number} · REPLAY`),won=game.status==='won',date=game.date;
  body.innerHTML='<div class="result-hero"><p class="result-kicker">PRACTICE REPLAY</p><h3></h3><p class="result-answer"></p><div class="result-score"></div><div class="result-squares" aria-label="Share result"></div></div><p class="replay-result-note">Just for fun. Your original points, stats, and streak are unchanged.</p><div class="result-bottom replay-actions"><button class="pixel-button primary share-button">'+icon('copy')+'COPY</button><button class="pixel-button" data-replay>PLAY AGAIN</button></div><button class="pixel-button wide" data-archive>Choose another M2ordle</button><button class="text-button back-link" data-home>Back to leaderboard</button>';
  body.querySelector('h3').textContent=won?'Nice, you got it!':'That was a tough one.';body.querySelector('.result-answer').textContent=game.answer.name;
  body.querySelector('.result-score').append(document.createTextNode(won?game.guesses.length:'X'));const outOf=document.createElement('span');outOf.textContent=' / 5';body.querySelector('.result-score').append(outOf);
  for(let i=0;i<5;i++){const square=document.createElement('i');square.className=game.guesses[i]?(game.guesses[i].correct?'correct':'wrong'):'';body.querySelector('.result-squares').append(square);}
  body.querySelector('.share-button').onclick=()=>copyResult(body);body.querySelector('[data-replay]').onclick=()=>startReplay(date,true);body.querySelector('[data-archive]').onclick=archive;body.querySelector('[data-home]').onclick=home;
}
async function checkReset(force=false){
  if(busy||checkingStatus||!siteStatus)return;
  const now=Date.now(),statusExpired=siteStatus.nextReset&&now>=new Date(siteStatus.nextReset).getTime();
  if(force||statusExpired||checkedLocalDate!==localCentralDate()||(statusRetryAfter&&now>=statusRetryAfter)){
    checkingStatus=true;const before=siteStatus.mode;
    try{await refreshStatus();if(before!==siteStatus.mode){game=null;home();return;}}
    finally{checkingStatus=false;}
  }
  if(game&&!game.replay&&game.nextReset&&now>=new Date(game.nextReset).getTime()&&screen==='game'){closeModal();game=null;await start();}
}
setInterval(()=>{document.querySelectorAll('[data-countdown]').forEach(el=>{if(game?.nextReset)el.textContent=countdown(game.nextReset);});checkReset();},1000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkReset(true);});
loading('Opening M2ordle…');
refreshStatus().then(home);
