const $ = id => document.getElementById(id);
let latest;
function setRemembered(value) {
  $('key-entry').hidden=value; $('remembered').hidden=!value; $('key').required=!value;
  if(value) $('key').value='';
}
fetch('/api/session').then(r=>r.json()).then(data=>setRemembered(data.authenticated)).catch(()=>{});
$('forget').onclick=async()=>{
  try {const r=await fetch('/api/session',{method:'DELETE'});if(!r.ok)throw Error('Could not forget access');setRemembered(false);}
  catch(error){$('status').textContent=error.message;}
};
const labels = {all_ages:'All-ages suitability',sexual:'Sexual content',violence:'Violence / weapons',hate:'Hate / harassment',adult:'Adult themes',frightening:'Frightening content',bypass:'Safety bypass'};
const names = {jev:'Jev',clef:'Clef','clef-flash':'Clef-flash'};
const el = (tag, text, cls) => {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
function render(results) {
  $('results').replaceChildren();
  for (const result of results) {
    const card=el('article',undefined,'card');card.append(el('h3',names[result.name]),el('div',result.id,'model-id'));
    card.append(el('span',result.outcome[0].toUpperCase()+result.outcome.slice(1),'decision '+result.outcome),el('span',Math.round(result.elapsedMs)+' ms','timing'));
    card.append(el('div',result.outcome==='unavailable'?'The safety service could not complete this check. Try again.':result.reasonCodes.length?'Flagged: '+result.reasonCodes.map(x=>labels[x]??'Uncertain suitability').join(', '):'All seven policy checks passed.','reasons'));
    if(result.scores)for(const [name,label] of Object.entries(labels)){
      const score=result.scores[name], limit=result.thresholds[name], failed=name==='all_ages'?score<limit:score>limit;
      const row=el('div',undefined,'score'+(failed?' failed':'')),head=el('div',undefined,'score-head');head.append(el('span',label),el('strong',Math.round(score*100)+'%'));
      const track=el('div',undefined,'track'),fill=el('div',undefined,'fill'),marker=el('div',undefined,'marker');fill.style.width=score*100+'%';marker.style.left=limit*100+'%';track.append(fill,marker);
      row.append(head,track,el('div',(name==='all_ages'?'Minimum ≥ ':'Maximum ≤ ')+Math.round(limit*100)+'%'+(failed?' · Failed':' · Passed'),'threshold'));card.append(row);
    }
    $('results').append(card);
  }
}
document.querySelectorAll('[data-prompt]').forEach(button=>button.onclick=()=>{$('prompt').value=button.dataset.prompt;$('prompt').focus();});
fetch('/api/config').then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{$('policy').textContent=data.policy;}).catch(()=>{$('policy').textContent='Policy unavailable';});
$('form').onsubmit=async event=>{
  event.preventDefault();$('compare').disabled=true;$('export').disabled=true;latest=undefined;$('results').replaceChildren();$('status').textContent='Checking the same prompt with all three classifiers…';
  try{
    if ($('key').value && $('remember').checked) {
      const login=await fetch('/api/session',{method:'POST',headers:{Authorization:'Bearer '+$('key').value}});
      const session=await login.json();if(!login.ok)throw Error(session.error??'Could not remember access');setRemembered(true);
    }
    const response=await fetch('/api/compare' ,{method:'POST',headers:{'Content-Type':'application/json',...($('key').value?{Authorization:'Bearer '+$('key').value}:{})},body:JSON.stringify({prompt:$('prompt').value}),signal:AbortSignal.timeout(30000)});
    const data=await response.json();if(!response.ok){if(response.status===401)setRemembered(false);throw Error(data.error??'Comparison failed');}latest=data;render(data.results);$('export').disabled=false;
    const decisions=data.results.filter(x=>x.allowed!==null);$('status').textContent='Completed · '+(decisions.length<3?'Some classifiers are unavailable.':decisions.every(x=>x.allowed===decisions[0].allowed)?'All three agree.':'The classifiers disagree.')+' · '+new Date(data.comparedAt).toLocaleTimeString();
  }catch(error){$('status').textContent=error.name==='TimeoutError'?'The request timed out. Try again.':error.message;}finally{$('compare').disabled=false;}
};
$('export').onclick=()=>{if(!latest)return;const url=URL.createObjectURL(new Blob([JSON.stringify(latest,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='moderation-comparison-'+latest.comparedAt.replaceAll(':','-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
