'use strict';
const $ = id => document.getElementById(id);
const STORAGE = 'wonderlines-comparisons-v1';
const MAX_IMAGES = 80;
const MAX_PARALLEL_GENERATIONS = 50;
const providerLabels = {'openai':'OpenAI', 'workers-ai':'Cloudflare', 'google-ai-studio':'Google', 'fal':'fal.ai'};
const presets = [{age:4, range:'3–5', detail:'Very simple'}, {age:7, range:'6–8', detail:'Simple'}, {age:10, range:'9–12', detail:'Detailed'}, {age:15, range:'13–18', detail:'Intricate'}];
const ageDetail = age => presets[age <= 5 ? 0 : age <= 8 ? 1 : age <= 12 ? 2 : 3].detail;
const selectedModels = new Set(['gpt-image-2.5-flare', 'flux-2-klein-4b']);
const selectedAges = new Set(presets.map(preset => preset.age));
let config, current, busy = false, history = [], pollEpoch = 0, activeCard;
let renderQueued = false;
function queueRender() {
  if(renderQueued)return;
  renderQueued=true;
  requestAnimationFrame(()=>{renderQueued=false;persist();renderGrid();});
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function el(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function message(id, text) { $(id).textContent = text || ''; $(id).hidden = !text; }
async function api(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin', ...options, headers:{'Content-Type':'application/json', ...options.headers}});
  let data; try { data = await response.json(); } catch { throw new Error('The service returned an unreadable response. Try again.'); }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/session') showLogin();
    const error = new Error(data.error?.message || 'The request could not be completed.'); error.status = response.status; error.code = data.error?.code; throw error;
  }
  return data;
}
function runSummary(run) {
  return {id:run.id,prompt:run.prompt,createdAt:run.createdAt,sequence:run.sequence,models:run.models,ages:run.ages,count:run.cells.length,
    ready:run.cells.filter(c=>c.status==='completed').length,failed:run.cells.filter(c=>c.status==='failed').length,
    previews:run.cells.filter(c=>c.status==='completed').slice(0,4).map(c=>c.id)};
}
function persist() {
  if(current)history=[runSummary(current),...history.filter(r=>r.id!==current.id)].sort((a,b)=>b.createdAt-a.createdAt||(b.sequence??0)-(a.sequence??0)||b.id.localeCompare(a.id)).slice(0,100);
  renderHistory();$('library-count').textContent=history.length;if(!$('library-view').hidden)renderLibrary();
}
function savePayload(run, imported=false) {
  return {id:run.id,prompt:run.prompt,composition:run.composition,createdAt:run.createdAt,imported,
    models:run.models.map(m=>({id:m.id})),ages:run.ages,cells:run.cells.map(c=>({id:c.id,model:c.model,age:c.age}))};
}
async function refreshLibrary() {
  const data=await api('/api/library');history=data.grids;renderHistory();renderLibrary();
}
async function migrateHistory() {
  let old;
  try {old=JSON.parse(localStorage.getItem(STORAGE)||'[]');}catch{return;}
  if(!Array.isArray(old)||!old.length)return;
  for(const run of old.slice(0,8)) {
    try {await api('/api/library',{method:'POST',body:JSON.stringify(savePayload(run,true))});}
    catch(error) {if(![400,409,410].includes(error.status))throw error;}
  }
  try {localStorage.removeItem(STORAGE);}catch{/* Server library is already saved. */}
}
function showView(view) {
  $('studio-view').hidden=view!=='studio';$('library-view').hidden=view!=='library';
  $('studio-tab').setAttribute('aria-current',view==='studio'?'page':'false');$('library-tab').setAttribute('aria-current',view==='library'?'page':'false');
}
async function openRun(id) {
  if(busy){if(current?.id===id)showView('studio');return;}
  try {
    const {grid}=await api('/api/library/'+id);current=grid;
    $('prompt').value=grid.prompt;$('composition').value=grid.composition;
    selectedModels.clear();grid.models.forEach(m=>selectedModels.add(m.id));selectedAges.clear();grid.ages.forEach(a=>selectedAges.add(a));
    renderOptions();renderGrid();renderHistory();showView('studio');
    if(!busy)await recover();
  }catch(error){message('library-error',error.message);message('library-status',error.message);}
}
function renderHistory() {
  const list=$('history-list');list.replaceChildren();
  if(!history.length){list.append(el('p','field-hint','Your next great idea starts here.'));return;}
  for(const run of history.slice(0,5)) {
    const button=el('button','history-item');button.type='button';button.disabled=busy&&run.id!==current?.id;
    button.setAttribute('aria-current',String(current?.id===run.id));
    button.append(el('strong','',run.prompt),el('small','',`${run.models.length} models · ${run.ages.length} ages · ${new Date(run.createdAt).toLocaleDateString(undefined,{day:'numeric',month:'short'})}`));
    button.addEventListener('click',()=>openRun(run.id));list.append(button);
  }
}
function renderLibrary() {
  $('library-count').textContent=history.length;
  const list=$('library-grid');list.replaceChildren();
  const search=$('library-search').value.trim().toLowerCase();
  const filtered=history.filter(run=>(run.prompt+' '+run.models.map(m=>m.label).join(' ')).toLowerCase().includes(search));
  if(!filtered.length){list.append(el('p','library-empty',history.length?'No comparisons match your search.':'Your saved comparisons will appear here after your first generation.'));return;}
  for(const run of filtered) {
    const button=el('button','library-card');button.type='button';button.disabled=busy&&run.id!==current?.id;
    const cover=el('div','library-cover');
    if(run.previews?.length)for(const id of run.previews){const image=el('img');image.src='/api/images/'+id;image.alt='';image.loading='lazy';cover.append(image);}
    else cover.append(el('span','','✳'));
    const text=el('div','library-card-text');text.append(el('h2','',run.prompt),el('p','',`${run.models.length} models × ${run.ages.length} ages · ${run.ready}/${run.count} ready`),el('small','',new Date(run.createdAt).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})));
    button.append(cover,text);button.addEventListener('click',()=>openRun(run.id));list.append(button);
  }
}
function updateAccess(access) { if (access && Number.isFinite(access.freeGenerationsRemaining)) { config.access = access; $('remaining').textContent = access.freeGenerationsRemaining; } }
function showLogin() {
  pollEpoch++; busy = false; $('workspace').hidden = true; $('login-view').hidden = false; $('logout').hidden = true;
}
async function openWorkspace() {
  config = await api('/api/config');
  $('login-view').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  updateAccess(config.access);
  try {await migrateHistory();await refreshLibrary();message('library-status','');}
  catch(error){message('library-status','The library could not be loaded. '+error.message);}
  renderOptions();renderHistory();
  if(!current&&history.length){const saved=await api('/api/library/'+history[0].id);current=saved.grid;$('prompt').value=current.prompt;$('composition').value=current.composition;selectedModels.clear();current.models.forEach(m=>selectedModels.add(m.id));renderOptions();}
  renderGrid(); await recover();
}
function renderOptions() {
  $('model-options').replaceChildren(); $('extra-model-options').replaceChildren();
  for (const model of config.models) {
    const label = el('label','model-option'), input = el('input'); input.type = 'checkbox'; input.checked = selectedModels.has(model.id); input.value = model.id; input.disabled = busy;
    const title = el('span'); title.append(el('span','',model.label),el('small','provider',providerLabels[model.provider] || model.provider)); label.append(input,title);
    input.addEventListener('change', () => { input.checked ? selectedModels.add(model.id) : selectedModels.delete(model.id); updateSummary(); });
    $(model.recommended ? 'model-options' : 'extra-model-options').append(label);
  }
  if(config.unavailableModels?.length){
    const note=el('details','provider-setup');note.append(el('summary','','Models requiring another endpoint'));
    for(const model of config.unavailableModels){const item=el('p');item.append(el('strong','',model.label+': '),document.createTextNode(model.reason));note.append(item);}
    $('extra-model-options').append(note);
  }
  $('age-options').replaceChildren();
  for (const preset of presets) {
    const button = el('button','age-button'); button.type = 'button'; button.disabled = busy; button.setAttribute('aria-pressed',String(selectedAges.has(preset.age))); button.setAttribute('aria-label',`Age ${preset.age}, ${preset.detail.toLowerCase()} detail`);
    button.append(el('strong','',preset.range),el('span','',preset.detail));
    button.addEventListener('click', () => { selectedAges.has(preset.age) ? selectedAges.delete(preset.age) : selectedAges.add(preset.age); renderOptions(); }); $('age-options').append(button);
  }
  $('exact-ages').replaceChildren();
  for (let age = 3; age <= 18; age++) {
    const button = el('button','',age); button.type = 'button'; button.disabled = busy; button.setAttribute('aria-pressed',String(selectedAges.has(age))); button.setAttribute('aria-label',`Age ${age}`);
    button.addEventListener('click', () => { selectedAges.has(age) ? selectedAges.delete(age) : selectedAges.add(age); renderOptions(); }); $('exact-ages').append(button);
  }
  updateSummary();
}
function updateSummary() {
  const count = selectedModels.size * selectedAges.size;
  $('prompt-count').textContent = `${$('prompt').value.length}/240`;
  $('combination-count').textContent = `${selectedModels.size} model${selectedModels.size===1?'':'s'} × ${selectedAges.size} age${selectedAges.size===1?'':'s'}`;
  $('image-count').textContent = `${count} sheet${count===1?'':'s'}`;
  $('compare').disabled = busy || !count || count > MAX_IMAGES || !$('prompt').value.trim();
  $('compare-label').textContent = busy ? 'Comparison in progress…' : 'Generate comparison';
  $('select-all-models').disabled = busy || config.models.every(model => selectedModels.has(model.id));
  message('form-error', count > MAX_IMAGES ? `Choose fewer models or ages. The limit is ${MAX_IMAGES} sheets per comparison.` : '');
}
function setBusy(value) {
  busy = value; $('prompt').disabled = value; $('composition').disabled = value;
  document.querySelectorAll('[data-example]').forEach(n => n.disabled = value); renderOptions(); renderHistory(); if(!$('library-view').hidden)renderLibrary();
}
function renderGrid() {
  const grid = $('comparison-grid'); grid.replaceChildren();
  $('empty-state').hidden = !!current; grid.hidden = !current; $('run-prompt').hidden = !current; $('export').disabled = !current;
  $('total-cost').hidden=!current;$('resume-comparison').hidden=!current||busy||!current.cells.some(c=>['queued','uncertain'].includes(c.status));
  const failed=current?.cells.filter(c=>c.status==='failed').length||0;
  $('retry-failed').hidden=!failed;$('retry-failed').disabled=busy;
  $('retry-failed').textContent=`Retry failed images (${failed})`;
  if (!current) { $('result-count').textContent = '0 sheets'; $('progress').hidden = true; return; }
  const costed=current.cells.filter(c=>Number.isFinite(c.metrics?.estimatedTotalUsd)&&c.metrics.estimatedTotalUsd>=0);
  const total=costed.reduce((sum,c)=>sum+c.metrics.estimatedTotalUsd,0);
  $('total-cost').textContent=costed.length?`Estimated total: $${total.toFixed(3)}`:'Estimated total: pending';
  $('total-cost').title=`${costed.length} of ${current.cells.length} images have a cost estimate. Excludes moderation, storage and other service charges.`;
  if(costed.length&&costed.length<current.cells.length)$('total-cost').textContent+=` · ${costed.length}/${current.cells.length} costed`;
  $('run-prompt').textContent = '“' + current.prompt + '”';
  const done = current.cells.filter(c => ['completed','failed'].includes(c.status)).length;
  const completed = current.cells.filter(c => c.status === 'completed').length;
  $('result-count').textContent = `${completed}/${current.cells.length} sheets`;
  $('progress').hidden = !busy;
  $('progress-label').textContent = `${done} of ${current.cells.length} finished · You can leave and return while images are drawing.`;
  grid.style.gridTemplateColumns = `76px repeat(${current.ages.length}, minmax(160px, 1fr))`;
  grid.append(el('div','grid-head','MODEL / AGE'));
  for (const age of current.ages) { const head = el('div','grid-head',`Age ${age}`); head.append(el('small','',ageDetail(age))); grid.append(head); }
  for (const model of current.models) {
    const label = el('div','grid-model',model.label); label.append(el('small','',providerLabels[model.provider] || model.provider));
    const timed=current.cells.filter(c=>c.model===model.id&&c.status==='completed'&&Number.isFinite(c.metrics?.elapsedMs)&&c.metrics.elapsedMs>=0);
    const mean=timed.length?timed.reduce((sum,c)=>sum+c.metrics.elapsedMs,0)/timed.length/1000:null;
    const timing=el('small','model-mean',mean===null?'Mean: —':`Mean: ${mean.toFixed(1)}s / image`);timing.title=`Mean elapsed generation time across ${timed.length} completed images; includes queue time.`;label.append(timing);grid.append(label);
    for (const age of current.ages) {
      const cell = current.cells.find(c => c.model === model.id && c.age === age); if (!cell) { grid.append(el('div')); continue; }
      const card = el('article','sheet-card');
      if (cell.status === 'completed') {
        const preview = el('button','sheet-preview'); preview.type = 'button'; preview.setAttribute('aria-label',`Enlarge ${model.label}, age ${age}`);
        const image = el('img'); image.src = `/api/images/${cell.id}`; image.alt = `${current.prompt} — ${model.label}, age ${age}`; image.loading = 'lazy';
        image.addEventListener('error', () => { image.hidden = true; const error = el('span','sheet-placeholder','Image unavailable. Unlock the workspace again or check the service.'); preview.append(error); }, {once:true});
        preview.append(image); preview.addEventListener('click', () => openImage(cell,model)); card.append(preview);
      } else {
        const preview = el('div','sheet-preview'), placeholder = el('div','sheet-placeholder');
        placeholder.append(el('span',cell.status === 'processing' || cell.status === 'submitting' ? 'spinner' : 'placeholder-icon',cell.status === 'queued' ? '✳' : cell.status === 'failed' ? '↗' : ''));
        placeholder.append(el('span','',({queued:'Waiting for its turn',submitting:'Starting your sheet',processing:'Drawing your idea',failed:'This one needs another try',uncertain:'Ready to check again'})[cell.status] || 'Waiting'));
        if(['failed','uncertain'].includes(cell.status)) {
          const retry=el('button','secondary sheet-retry',cell.status==='failed'?'Retry image':'Check / resume');retry.type='button';retry.disabled=busy;
          retry.setAttribute('aria-label',`${retry.textContent}: ${model.label}, age ${age}`);
          retry.addEventListener('click',()=>retryCells([cell]));placeholder.append(retry);
        }
        preview.append(placeholder); card.append(preview);
      }
      const info = el('button','sheet-info','i'); info.type = 'button';
      info.setAttribute('aria-label',`Details for ${model.label}, age ${age}`); info.title = 'Image details';
      info.addEventListener('click',()=>openDetails(cell,model));
      card.append(info); grid.append(card);
    }
  }
}
function openImage(cell, model) {
  activeCard = document.activeElement;
  $('dialog-title').textContent = `${model.label} · Age ${cell.age} · ${ageDetail(cell.age)}`;
  $('dialog-image').src = `/api/images/${cell.id}`; $('dialog-image').alt = `${current.prompt} — ${model.label}, age ${cell.age}`;
  $('image-dialog').showModal();
}
function openDetails(cell, model) {
  activeCard = document.activeElement;
  $('details-title').textContent = `${model.label} · Age ${cell.age}`;
  const list = $('details-list'); list.replaceChildren();
  const row = (label,value) => { if(value !== null && value !== undefined) list.append(el('dt','',label),el('dd','',typeof value === 'object' ? JSON.stringify(value) : String(value))); };
  row('Prompt',current.prompt); row('Model',model.label); row('Provider',providerLabels[model.provider] || model.provider);
  row('Age',`${cell.age} · ${ageDetail(cell.age)}`); row('Status',({completed:'Ready to colour',failed:'Not generated',uncertain:'Check again',processing:'Drawing',submitting:'Starting',queued:'Waiting'})[cell.status] || cell.status);
  if(cell.error) row('Message',cell.error);
  if(cell.errorCode) row('Error code',cell.errorCode);
  row('Generation ID',cell.id);
  for(const [key,value] of Object.entries(cell.metrics || {})) row(key,value);
  $('details-note').hidden = !cell.metrics;
  const actions = $('details-actions'); actions.replaceChildren();
  if(['uncertain','failed'].includes(cell.status)) {
    const retry = el('button','secondary',cell.status === 'failed' ? 'Retry image' : 'Check / resume'); retry.type='button'; retry.disabled=busy;
    retry.addEventListener('click',async()=>{
      if(busy)return;
      $('details-dialog').close();
      await retryCells([cell]);
    }); actions.append(retry);
  }
  $('details-dialog').showModal();
}
function applyJob(cell, job) {
  const error=job.error?.message||null;
  const errorCode=job.error?.code||null;
  const changed=cell.status!==job.status||cell.error!==error||cell.errorCode!==errorCode||JSON.stringify(cell.metrics)!==JSON.stringify(job.metrics);
  cell.status=job.status;cell.metrics=job.metrics;cell.error=error;cell.errorCode=errorCode;updateAccess(job.access);
  if(changed)queueRender();
}
async function runCell(cell, epoch, recoveryOnly = false) {
  if (epoch !== pollEpoch) return;
  if (['completed','failed'].includes(cell.status)) return;
  let submitted = !['queued','submitting','uncertain'].includes(cell.status);
  try {
    if (recoveryOnly || cell.status === 'uncertain') {
      try { const job = await api(`/api/generations/${cell.id}`); applyJob(cell,job); submitted=true; }
      catch(error) { if(error.status !== 404) throw error; submitted=false; }
      if(recoveryOnly&&!submitted){cell.status='queued';cell.error=null;persist();renderGrid();return;}
    }
    if (!submitted) {
      cell.status='submitting'; cell.error=null; queueRender();
      const job = await api('/api/generations',{method:'POST',body:JSON.stringify({id:cell.id,batchID:current.id,description:current.prompt,age:cell.age,model:cell.model,composition:current.composition})}); applyJob(cell,job);
    }
    const deadline = Date.now()+31*60*1000;
    let failures=0;
    while (!['completed','failed'].includes(cell.status) && epoch === pollEpoch) {
      if(Date.now()>deadline) { cell.status='uncertain'; cell.error='This is taking longer than expected. Check again to recover the same image.'; break; }
      await wait(document.hidden ? 10000 : 4000);
      if(epoch !== pollEpoch) return;
      try { applyJob(cell,await api(`/api/generations/${cell.id}`)); failures=0; }
      catch(error) { failures++; if(error.status===401 || failures>=4) throw error; }
    }
  } catch(error) {
    // A dropped response may already have queued an image. Keep the same ID so
    // resuming never creates a second billed generation.
    cell.status=error.status && [400,403,409,410,429].includes(error.status) ? 'failed' : 'uncertain';
    cell.error=error.message || 'Connection interrupted. Resume to check the same image.';
    cell.errorCode=error.code||null;
  }
  queueRender();
}
async function retryCells(cells) {
  if(busy||!current)return;
  const queue=cells.filter(cell=>current.cells.includes(cell)&&['failed','uncertain'].includes(cell.status));
  if(!queue.length)return;
  const epoch=++pollEpoch;setBusy(true);renderGrid();
  async function worker() {
    while(queue.length&&epoch===pollEpoch) {
      const cell=queue.shift();
      try {
        if(cell.status==='failed') {
          // Confirm the server's outcome before replacing an ID. A lost response
          // or stale tab must never turn a completed/in-flight image into a second charge.
          try {applyJob(cell,await api(`/api/generations/${cell.id}`));}
          catch(error){if(error.status!==404)throw error;}
          if(epoch!==pollEpoch)return;
          if(cell.status==='failed') {
            cell.id=crypto.randomUUID();cell.status='queued';cell.metrics=null;cell.error=null;cell.errorCode=null;
          }
        }
        await runCell(cell,epoch);
      }catch(error){cell.error=error.message;cell.errorCode=error.code||null;queueRender();}
    }
  }
  try {await Promise.all(Array.from({length:Math.min(MAX_PARALLEL_GENERATIONS,queue.length)},worker));}
  finally {if(epoch===pollEpoch){setBusy(false);persist();renderGrid();}}
}
async function runCells(recovery = false) {
  const epoch=++pollEpoch; setBusy(true); renderGrid();
  const queue=current.cells.filter(c=>!['completed','failed'].includes(c.status)&&(!recovery||c.status!=='queued'));
  async function worker() { while(queue.length && epoch===pollEpoch) await runCell(queue.shift(),epoch,recovery); }
  await Promise.all(Array.from({length:Math.min(MAX_PARALLEL_GENERATIONS,queue.length)},worker));
  if(epoch !== pollEpoch) return;
  setBusy(false); persist(); renderGrid();
}
async function recover() { if(current?.cells.some(c=>['processing','submitting','uncertain'].includes(c.status))) await runCells(true); }
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault(); $('unlock').disabled=true; message('login-error','');
  try { await api('/api/session',{method:'POST',body:JSON.stringify({key:$('access-key').value.trim(),remember:$('remember').checked})}); $('access-key').value=''; await openWorkspace(); }
  catch(error) { message('login-error',error.message); } finally { $('unlock').disabled=false; }
});
$('show-key').addEventListener('click',()=>{const show=$('access-key').type==='password'; $('access-key').type=show?'text':'password'; $('show-key').textContent=show?'Hide':'Show'; $('show-key').setAttribute('aria-label',show?'Hide access key':'Show access key');});
$('logout').addEventListener('click',async()=>{try {await api('/api/session',{method:'DELETE'});showLogin();$('access-key').focus();}catch(error){message('form-error',error.message);}});
$('prompt').addEventListener('input',updateSummary);
$('studio-tab').addEventListener('click',()=>showView('studio'));
async function browseLibrary(){showView('library');try{await refreshLibrary();message('library-error','');}catch(error){message('library-error',error.message);}}
$('library-tab').addEventListener('click',browseLibrary);$('browse-library').addEventListener('click',browseLibrary);
$('library-search').addEventListener('input',renderLibrary);
$('resume-comparison').addEventListener('click',()=>{if(!busy&&current)runCells();});
$('retry-failed').addEventListener('click',()=>retryCells(current?.cells.filter(c=>c.status==='failed')||[]));
$('select-all-models').addEventListener('click',()=>{config.models.forEach(model=>selectedModels.add(model.id));document.querySelector('.more-models').open=true;renderOptions();});
document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>{$('prompt').value=button.dataset.example; updateSummary(); $('prompt').focus();}));
$('compare-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(busy) return;
  const count=selectedModels.size*selectedAges.size;
  if(!count || count>MAX_IMAGES || !$('prompt').value.trim()) return;
  const models=config.models.filter(m=>selectedModels.has(m.id)); const ages=[...selectedAges].sort((a,b)=>a-b);
  current={id:crypto.randomUUID(),prompt:$('prompt').value.trim(),composition:$('composition').value,models,ages,createdAt:Date.now(),cells:[]};
  for(const model of models) for(const age of ages) current.cells.push({id:crypto.randomUUID(),model:model.id,age,status:'queued',metrics:null,error:null});
  setBusy(true);message('library-status','Saving comparison to the library…');
  try {const saved=await api('/api/library',{method:'POST',body:JSON.stringify(savePayload(current))});current=saved.grid;persist();renderGrid();message('library-status','Saved to library');if(innerWidth<761)$('comparison-grid').scrollIntoView({behavior:'smooth',block:'start'});await runCells();}
  catch(error){setBusy(false);message('library-status','Could not save the comparison. '+error.message);message('form-error',error.message);}
});
$('export').addEventListener('click',()=>{if(!current)return; const blob=new Blob([JSON.stringify({...current,note:'Image URLs require an authenticated session; API keys are never included.'},null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=el('a'); a.href=url;a.download=`wonderlines-comparison-${current.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('close-dialog').addEventListener('click',()=>$('image-dialog').close());
$('image-dialog').addEventListener('click',event=>{if(event.target===$('image-dialog'))$('image-dialog').close();});
$('image-dialog').addEventListener('close',()=>{activeCard?.focus();});
$('close-details').addEventListener('click',()=>$('details-dialog').close());
$('details-dialog').addEventListener('click',event=>{if(event.target===$('details-dialog'))$('details-dialog').close();});
$('details-dialog').addEventListener('close',()=>{activeCard?.focus();});
(async()=>{try {const session=await api('/api/session');if(session.authenticated)await openWorkspace();}catch(error){message('login-error',error.message);}})();
