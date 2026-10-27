import {DEFAULT_MODEL, modelCatalog, imageRequest, falImageTask} from './image-provider.mjs';
import {structuredComposition, MAX_DESCRIPTION_LENGTH, MAX_COMPOSED_SUBJECT_LENGTH} from './composition.mjs';
import {moderateSubject, ModerationError} from './moderation.mjs';

const failure = (code,message,status,details={}) => ({status,value:{error:{code,message,...details}}});
const DEFAULT_SIZE = {width:1024,height:1456};
function dimensions(input) {
  const {width,height}=input??{};
  if(width===undefined&&height===undefined)return DEFAULT_SIZE;
  return Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=3840&&height<=3840&&
    width%16===0&&height%16===0&&width/height>=1/3&&width/height<=3&&width*height>=655360&&width*height<=3686400?{width,height}:null;
}

export async function generationFingerprints(subject,model,size) {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({subject,model,...size}))));
  // Both formats already exist in saved app/API and comparison jobs. Accept
  // either on recovery so this refactor never resubmits an existing image.
  return {
    base64url:btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''),
    hex:Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('')
  };
}

export async function prepareGeneration(input,generationId,env={}) {
  if(!input||!(/^[0-9a-f-]{36}$/).test(generationId??''))return failure('invalid_request','Send JSON and a UUID Idempotency-Key.',400);
  const size=dimensions(input);
  const structured=Object.hasOwn(input,'batchID')||Object.hasOwn(input,'description');
  const composed=structured?structuredComposition(input):null;
  if(structured&&!composed)return failure('invalid_request','Invalid description or composition.',400);
  const subject=composed?.subject??input.subject;
  const subjectLimit=composed?MAX_COMPOSED_SUBJECT_LENGTH:MAX_DESCRIPTION_LENGTH;
  if(typeof subject!=='string'||!subject.trim()||subject.length>subjectLimit||!size)return failure('invalid_request','Description or dimensions are invalid.',400);
  const model=input.model??env.IMAGE_DEFAULT_MODEL??DEFAULT_MODEL;
  return {generationId,subject,model,size,composed,fingerprints:await generationFingerprints(subject,model,size)};
}

// Authentication, HTTP/image responses and library storage belong to the
// caller. Validation, recovery, moderation and reservation follow one path.
export async function startGeneration(prepared,{env,call,queueImages=false,comparisonModels=false,validateProvider=true,fingerprintFormat='base64url',allowRoute,rateLimit,beforeReserve,onModeration}) {
  if(prepared.value?.error)return prepared;
  const {generationId,subject,model,size,composed,fingerprints}=prepared;
  const existing=await call('/job',{generationId});
  if(existing.status===200)return Object.values(fingerprints).includes(existing.value.job.fingerprint)
    ? {status:200,job:existing.value.job,access:existing.value.access,recovered:true}
    : failure('idempotency_conflict','Generation ID was already used.',409);
  if(existing.status!==404)return failure('service_unavailable','Could not check generation.',503);
  let routes,upstreamRequest;
  try {routes=modelCatalog(env,{comparison:comparisonModels}).routes;}catch{return failure('service_unavailable','Image model configuration is incomplete.',503);}
  if(typeof model!=='string'||!Object.hasOwn(routes,model)||allowRoute&&!allowRoute(routes[model]))return failure('invalid_request','Model is invalid.',400);
  try {
    upstreamRequest=validateProvider?imageRequest(env,routes[model],subject,size):
      routes[model].provider==='fal'?falImageTask(routes[model].model,subject,size):{provider:routes[model].provider,model:routes[model].model};
  }catch{return failure('service_unavailable','Image provider configuration is incomplete.',503);}
  if(rateLimit){const limited=await rateLimit();if(limited)return limited;}
  if(composed) {
    const decision=await call('/moderate-batch',{batchID:composed.batchID,description:composed.description});
    if(decision.status!==200){onModeration?.({structured:true,generationId,batchID:composed.batchID,outcome:decision.value.error?.code,status:decision.status});return decision;}
  } else try {
    const diagnostics=await moderateSubject(env,subject);
    onModeration?.({structured:false,generationId,outcome:'approved',diagnostics,reasonCodes:[]});
  }catch(error){
    if(!(error instanceof ModerationError))throw error;
    onModeration?.({structured:false,generationId,outcome:error.code,diagnostics:error.diagnostics,reasonCodes:error.reasonCodes});
    return failure(error.code,error.message,error.status,{reasonCodes:error.reasonCodes});
  }
  await beforeReserve?.();
  const result=await call('/reserve',{generationId,fingerprint:fingerprints[fingerprintFormat],
    ...(upstreamRequest.provider==='fal'&&!comparisonModels?{falTask:{request:upstreamRequest,publicModel:model,requestedSize:size.width+'x'+size.height}}:
      queueImages?{imageTask:{route:routes[model],subject,size,publicModel:model}}:{})});
  if(result.status===429)return result;
  if(result.status>=400)return failure('generation_unavailable','Could not start generation.',result.status);
  return {status:result.status,job:result.value.job,access:result.value.access,recovered:result.status===200,upstreamRequest};
}
