const $=id=>document.getElementById(id);
const providers={openai:'OpenAI','google-ai-studio':'Google','workers-ai':'Cloudflare',fal:'fal.ai'};
const state={head:null,draft:null,validation:null,history:[],cursor:null,busy:false,pending:null,uncertain:null,lastSubmission:null,timer:null,conflict:false};
const copy=value=>structuredClone(value);
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const dirty=()=>!!state.head&&JSON.stringify(state.draft)!==JSON.stringify(state.head.document);
function message(text,error=false){$('message').textContent=text;$('message').hidden=!text;$('message').classList.toggle('error',error);}
async function api(path,options={}) {
  const response=await fetch('/api/admin'+path,{credentials:'same-origin',cache:'no-store',...options,
    headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
  const data=await response.json();
  if(response.status===401){clearTimeout(state.timer);$('admin-workspace').hidden=true;$('admin-login').hidden=false;$('google-signin').hidden=false;$('login-status').textContent='Your session expired. Sign in again to continue.';}
  if(!response.ok){const error=new Error(data.error?.message??'The request could not be completed.');error.code=data.error?.code;error.status=response.status;error.details=data;throw error;}
  return data;
}
async function run(action){if(state.busy)return;state.busy=true;updateControls();try{await action();}catch(error){message(error.message,true);}finally{state.busy=false;updateControls();}}
function changed(){state.validation=null;$('validation-result').hidden=true;updateControls();updateSummary();}
function updateSummary(){
  const available=state.draft?.models.filter(model=>model.enabled&&model.visible&&state.draft.providers[model.provider]?.enabled)??[];
  $('visible-count').textContent=String(available.length);
}
function updateControls(){
  const blocked=state.busy||!!state.pending||!!state.uncertain||!state.head||!state.draft;
  $('editor-fields').disabled=blocked;
  $('validate').disabled=blocked||!dirty();
  $('publish').disabled=blocked||!dirty()||!state.validation?.valid||!$('change-note').value.trim();
  $('discard').disabled=blocked||(!dirty()&&!state.conflict);
  $('review-draft').disabled=blocked||!dirty();
  $('draft-state').textContent=state.pending?'Publishing recorded change…':state.uncertain?'Checking publishing status…':dirty()?'Unsaved draft':'Published catalogue';
  $('refresh-history').disabled=state.busy;
  $('refresh-history').textContent=state.uncertain?'Check publishing':'Refresh';
  $('more-history').disabled=state.busy;
  for(const button of document.querySelectorAll('[data-restore]'))button.disabled=blocked||dirty()||button.dataset.restore===state.head?.id;
}
function field(labelText,value,onChange,{kind='text',max,wide=false,required=false}={}) {
  const wrapper=element('label',wide?'wide':'');wrapper.append(element('span','field-label',labelText));
  const control=element(kind==='textarea'?'textarea':'input');
  if(kind!=='textarea')control.type=kind;
  control.value=value??'';
  if(max)control.maxLength=max;
  if(required)control.required=true;
  if(kind==='number'){control.min='0';control.max='10000';control.step='any';}
  control.addEventListener('input',()=>{onChange(control.value);changed();});
  wrapper.append(control);return wrapper;
}
function checkbox(labelText,checked,onChange,className=''){
  const label=element('label',className),input=element('input');input.type='checkbox';input.checked=checked;
  input.addEventListener('change',()=>{onChange(input.checked);changed();});label.append(input,document.createTextNode(labelText));return label;
}
function renderDefault(){
  const select=$('default-model');select.replaceChildren();
  const automatic=element('option',null,'Automatic: first available model');automatic.value='';select.append(automatic);
  for(const model of state.draft.models){const active=model.enabled&&model.visible&&state.draft.providers[model.provider]?.enabled;
    const option=element('option',null,model.label+(active?'':' (unavailable)'));option.value=model.id;select.append(option);}
  select.value=state.draft.defaultModel??'';
}
function renderEditor(){
  const container=$('provider-controls');container.replaceChildren();
  for(const [provider,label] of Object.entries(providers)){
    container.append(checkbox(label,state.draft.providers[provider]?.enabled??false,enabled=>{
      state.draft.providers[provider]={enabled};renderDefault();
    },'provider-control'));
  }
  renderDefault();
  const models=$('model-controls');models.replaceChildren();
  if(!state.draft.models.length)models.append(element('p','empty-models','No models in this draft. Add a model or restore a previous catalogue.'));
  state.draft.models.forEach((model,index)=>{
    const card=element('article','model-card'),top=element('div','model-top');
    const name=field('Model name',model.label,value=>{model.label=value;renderDefault();},{max:120,required:true});name.className='model-name';top.append(name);
    const actions=element('div','model-actions');
    for(const [symbol,label,move] of [['↑','Move model up',-1],['↓','Move model down',1],['×','Remove model',0]]){
      const button=element('button',null,symbol);button.type='button';button.setAttribute('aria-label',label+' · '+model.label);
      button.disabled=move===-1&&index===0||move===1&&index===state.draft.models.length-1;
      button.addEventListener('click',()=>{if(move){const list=state.draft.models;[list[index],list[index+move]]=[list[index+move],list[index]];}
        else{state.draft.models.splice(index,1);if(state.draft.defaultModel===model.id)state.draft.defaultModel=null;}
        renderEditor();changed();});actions.append(button);
    }
    top.append(actions);card.append(top);
    const switches=element('div','model-switches');
    const enabled=checkbox('Enabled',model.enabled,value=>{model.enabled=value;renderDefault();});enabled.querySelector('input').className='enabled-control';
    switches.append(enabled,checkbox('Show in picker',model.visible,value=>{model.visible=value;renderDefault();}),element('span','model-provider',providers[model.provider]??model.provider));
    card.append(switches);
    const details=element('details'),summary=element('summary',null,'Edit description, routing and price');details.append(summary);
    const description=field('Description',model.detail,value=>model.detail=value,{kind:'textarea',max:600,required:true});description.className='model-description';details.append(description);
    const fields=element('div','model-fields');
    fields.append(field('Public model ID',model.id,value=>{if(state.draft.defaultModel===model.id)state.draft.defaultModel=value;model.id=value;renderDefault();},{max:128,required:true}));
    const providerField=element('label');providerField.append(element('span','field-label','Provider'));
    const select=element('select');for(const [id,label] of Object.entries(providers)){const option=element('option',null,label);option.value=id;select.append(option);}select.value=model.provider;
    select.addEventListener('change',()=>{model.provider=select.value;if(!state.draft.providers[model.provider])state.draft.providers[model.provider]={enabled:true};switches.querySelector('.model-provider').textContent=providers[model.provider];renderDefault();changed();});providerField.append(select);fields.append(providerField);
    fields.append(field('Upstream model or supported preset',model.model,value=>model.model=value,{max:128,wide:true,required:true}));
    const priceContainer=element('div','wide');
    function renderPrice(){priceContainer.replaceChildren();priceContainer.append(checkbox('Include a reference price',model.price!==null,value=>{
      model.price=value?{usd:0,evidence:'Estimate',explanation:''}:null;renderPrice();
    },'price-toggle'));
      if(model.price){const priceFields=element('div','model-fields');
        priceFields.append(field('US cents per image',model.price.usd*100,value=>model.price.usd=value===''?null:Number(value)/100,{kind:'number',required:true}),
          field('Price evidence',model.price.evidence,value=>model.price.evidence=value,{max:80,required:true}),
          field('Price explanation',model.price.explanation,value=>model.price.explanation=value,{kind:'textarea',max:600,wide:true,required:true}));priceContainer.append(priceFields);}
    }
    renderPrice();fields.append(priceContainer);details.append(fields);card.append(details);models.append(card);
  });
  updateSummary();updateControls();
}
function renderValidation(result){
  const panel=$('validation-result');panel.replaceChildren();panel.hidden=false;panel.classList.toggle('invalid',!result.valid);
  panel.append(element('div','validation-title',result.valid?`Valid catalogue · ${result.visibleCount} visible models · ${result.enabledCount} enabled routes`:'Fix these issues before publishing'));
  const lines=result.valid?[...result.warnings,...result.changes]:result.issues.map(issue=>issue.path+': '+issue.message);
  if(lines.length){const list=element('ul');for(const line of lines)list.append(element('li',null,line));panel.append(list);}
}
function renderHistory(){
  const list=$('history-list');list.replaceChildren();
  for(const version of state.history){
    const item=element('li'),heading=element('div','history-label');
    heading.append(element('span',null,({baseline:'Initial catalogue',external:'External change',publish:'Published',rollback:'Restored'})[version.action]??'Change'));
    if(version.id===state.head?.id)heading.append(element('span','current-tag','CURRENT'));
    const date=new Date(version.createdAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
    item.append(heading,element('p','history-note',version.note),element('div','history-detail',date),element('div','history-detail',version.actor?.email??'Existing catalogue / external edit'));
    const actions=element('div','history-actions'),view=element('button','text-button','View version');view.type='button';
    view.addEventListener('click',()=>run(async()=>{const {version:record}=await api('/models/versions/'+version.id);$('version-title').textContent='Version '+record.sequence;$('version-note').textContent=record.note;$('version-json').textContent=JSON.stringify(record.document,null,2);$('version-dialog').showModal();}));
    const restore=element('button','secondary',version.id===state.head?.id?'Current version':'Restore this version');restore.type='button';restore.dataset.restore=version.id;
    restore.addEventListener('click',()=>run(()=>submitChange('/models/rollback',{targetVersion:version.id,baseVersion:state.head.id,requestId:crypto.randomUUID()})));
    actions.append(view,restore);item.append(actions);list.append(item);
  }
  $('more-history').hidden=state.cursor===null;updateControls();
}
async function loadHistory(append=false){const result=await api('/models/history'+(append&&state.cursor?'?before='+state.cursor:''));state.history=append?[...state.history,...result.versions]:result.versions;state.cursor=result.nextCursor;renderHistory();}
async function loadCurrent(reset=true){
  const data=await api('/models');state.head=data.head;state.pending=data.pending;
  $('current-version').textContent=`Version ${data.head.sequence} · ${data.head.revision}`;
  if(reset){state.conflict=false;state.draft=copy(data.head.document);state.validation=null;$('validation-result').hidden=true;$('change-note').value='';renderEditor();}
  message(data.warning??'');renderHistory();updateControls();
  if(data.pending)pollPublication();
}
function pollPublication(){
  clearTimeout(state.timer);
  state.timer=setTimeout(async()=>{
    try{const data=await api('/models');state.pending=data.pending;
      if(data.pending){message('Your change is recorded and still publishing. You can leave this page; publishing will continue.');pollPublication();}
      else{state.uncertain=null;await loadCurrent();await loadHistory();message('Catalogue published. Devices will receive the update as their catalogue refreshes.');}
    }catch(error){message(error.message+' Your recorded change is still being checked.',true);if(state.pending)pollPublication();}
    updateControls();
  },4000);
}
async function checkUncertain(){
  const request=state.uncertain;
  if(!request)return;
  try{const result=await api('/models/operations/'+request.requestId);state.uncertain=null;
    if(result.status==='publishing'){state.pending=result.version;message('Your change is recorded and still publishing.');pollPublication();}
    else{await loadCurrent();await loadHistory();message('Your change was published.');}
  }catch(error){if(error.status===404){state.uncertain=null;message('No completed change was found. Your draft is kept; you can retry publishing.');}else throw error;}
}
async function submitChange(path,input){
  const submission={path,input};state.lastSubmission=submission;
  let result;
  try{result=await api(path,{method:'POST',body:JSON.stringify(input)});}
  catch(error){
    if(error.code==='version_conflict'){state.conflict=true;state.validation=null;message(error.message+' Your draft is kept.',true);return;}
    if(error.status===400&&error.details?.issues){state.validation=error.details;renderValidation(error.details);return;}
    if(!error.status||error.status>=500){state.uncertain=input;message('Publishing could not be confirmed. Checking the recorded change before allowing another edit…',true);await checkUncertain();return;}
    throw error;
  }
  state.uncertain=null;
  if(result.status==='publishing'){state.pending=result.version;message('Your change is recorded and still publishing. You can leave this page; publishing will continue.');pollPublication();}
  else{await loadCurrent();await loadHistory();message(path.endsWith('rollback')?'Previous catalogue restored. A new version has been added to the history.':'Catalogue published. Devices will receive the update as their catalogue refreshes.');}
}
$('default-model').addEventListener('change',()=>{state.draft.defaultModel=$('default-model').value||null;changed();});
$('change-note').addEventListener('input',updateControls);
$('add-model').addEventListener('click',()=>{if(state.draft.models.length>=32){message('A catalogue can contain at most 32 models.',true);return;}
  let index=1;while(state.draft.models.some(model=>model.id==='new-model-'+index))index++;
  state.draft.models.push({id:'new-model-'+index,provider:'openai',model:'',enabled:false,visible:true,label:'New model',detail:'',price:null});renderEditor();changed();$('model-controls').lastElementChild?.scrollIntoView({block:'center'});
});
$('validate').addEventListener('click',()=>run(async()=>{
  const snapshot=JSON.stringify(state.draft),result=await api('/models/validate',{method:'POST',body:JSON.stringify({document:state.draft})});
  if(snapshot!==JSON.stringify(state.draft))return;
  if(result.currentVersion!==state.head.id){state.conflict=true;state.validation=null;message('The catalogue changed in another tab. Discard this draft and reload the current version before publishing.',true);return;}
  state.validation=result;renderValidation(result);
}));
$('catalogue-form').addEventListener('submit',event=>{event.preventDefault();if(!state.validation?.valid||!dirty()||!$('change-note').value.trim())return;
  run(()=>{const draft={document:copy(state.draft),note:$('change-note').value.trim(),baseVersion:state.head.id};
    const old=state.lastSubmission;
    const requestId=old?.path==='/models/publish'&&JSON.stringify({...old.input,requestId:undefined})===JSON.stringify(draft)?old.input.requestId:crypto.randomUUID();
    return submitChange('/models/publish',{...draft,requestId});
  });
});
$('review-draft').addEventListener('click',()=>{$('change-note').scrollIntoView({block:'center'});$('change-note').focus({preventScroll:true});});
$('discard').addEventListener('click',()=>run(async()=>{await loadCurrent();await loadHistory();}));
$('refresh-history').addEventListener('click',()=>run(async()=>{if(state.uncertain)await checkUncertain();if(!state.head)await loadCurrent();await loadHistory();}));
$('more-history').addEventListener('click',()=>run(()=>loadHistory(true)));
$('close-version').addEventListener('click',()=>$('version-dialog').close());
$('sign-out').addEventListener('click',()=>run(async()=>{await api('/logout',{method:'POST',body:'{}'});location.replace('/admin/models');}));
window.addEventListener('beforeunload',event=>{if(dirty()&&!state.pending){event.preventDefault();event.returnValue='';}});
async function start(){
  try{const session=await api('/session');
    if(!session.authenticated){$('google-signin').hidden=!session.configured;
      const login=new URL(location.href).searchParams.get('login');
      $('login-status').textContent=!session.configured?'Google sign-in is not configured yet. The site owner needs to finish the Google OAuth setup.':login==='failed'?'Sign-in failed or this Google account is not authorized. Try again with the authorized account.':login==='cancelled'?'Google sign-in was cancelled. You can try again.':'Only the authorized Google account can access model controls.';return;}
    $('admin-login').hidden=true;$('admin-workspace').hidden=false;$('sign-out').hidden=false;$('signed-in-as').textContent='Signed in as '+session.email;
    await run(async()=>{await loadCurrent();await loadHistory();});
  }catch(error){$('login-status').textContent=error.message;}
}
start();
