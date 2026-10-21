import {imageRequest,runImageRequest,ImageProviderError} from './image-provider.mjs';
import {imageCost} from './image-cost.mjs';
import {isUUID,MAX_COMPOSED_SUBJECT_LENGTH} from './composition.mjs';

// One durable runner per comparison image gives inference its own I/O context.
// Account still owns moderation, idempotency, all budget reservations and results.
export class ComparisonImageRunner {
  constructor(state,env){this.state=state;this.env=env;this.queue=Promise.resolve();this.active=null;}
  fetch(request){
    const result=this.queue.then(async()=>{
      const input=await request.json().catch(()=>null);
      if(!input||request.method!=='POST'||!isUUID(input.id)||input.accountId!==this.env.COMPARISON_ACCOUNT_ID||!isUUID(input.accountId)||typeof input.fingerprint!=='string'||!Number.isSafeInteger(input.createdAt)||typeof input.subject!=='string'||input.subject.length>MAX_COMPOSED_SUBJECT_LENGTH||!input.route||!input.size)return Response.json({error:'Invalid task'},{status:400});
      const previous=await this.state.storage.get('task');
      if(previous)return Response.json({accepted:previous.id===input.id&&previous.accountId===input.accountId&&previous.fingerprint===input.fingerprint},{status:previous.id===input.id&&previous.accountId===input.accountId&&previous.fingerprint===input.fingerprint?202:409});
      await this.state.storage.transaction(async storage=>{await storage.put('task',{...input,stage:'queued'});await storage.setAlarm(Date.now()+1);});
      return Response.json({accepted:true},{status:202});
    });
    this.queue=result.catch(()=>{});return result;
  }
  async account(path,input,accountId){
    const stub=this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(accountId));
    return stub.fetch('https://account'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  }
  async report(task){
    const response=await this.account('/complete',{generationId:task.id,result:task.result},task.accountId);
    if(!response.ok){
      await response.body?.cancel();
      const found=await this.account('/job',{generationId:task.id},task.accountId);
      const data=await found.json();
      if(found.ok&&['completed','failed'].includes(data.job?.state)){
        // A previous completion response was lost. Do not report or infer twice.
      }else if([404,410].includes(found.status)){
        await this.env.GENERATIONS.delete(task.accountId+'/'+task.id+'.png');
      }else throw new Error('Comparison result reporting unavailable');
    }else await response.body?.cancel();
    // Keep only the idempotency receipt, not prompts or provider request data.
    await this.state.storage.put('task',{id:task.id,accountId:task.accountId,fingerprint:task.fingerprint,stage:'done'});
  }
  async finish(task,result){task.stage='reporting';task.result=result;delete task.subject;delete task.route;delete task.size;await this.state.storage.put('task',task);await this.report(task);}
  async run(){
    const task=await this.state.storage.get('task');if(!task||task.stage==='done')return;
    await this.state.storage.setAlarm(Date.now()+30000);
    if(task.stage==='reporting'){await this.report(task);return;}
    const objectKey=task.accountId+'/'+task.id+'.png';
    if(task.stage!=='queued'){
      if(task.stage==='saving'&&await this.env.GENERATIONS.get(objectKey))return this.finish(task,{state:'completed',objectKey,metrics:task.metrics});
      return this.finish(task,{state:'failed',errorCode:'provider_connection_failed',message:'The image request was interrupted. No automatic second generation was submitted.'});
    }
    let request;
    try{request=imageRequest(this.env,task.route,task.subject,task.size);}
    catch{return this.finish(task,{state:'failed',errorCode:'provider_unavailable',message:'The image provider is not configured for this model.'});}
    task.stage='submitting';await this.state.storage.put('task',task);
    const started=Date.now();
    try{
      const result=await runImageRequest(request);
      task.metrics={requestedModel:task.publicModel,provider:request.provider,upstreamModel:request.model,viaGateway:request.viaGateway,
        requestedSize:task.size.width+'x'+task.size.height,size:result.size,inputTokens:result.inputTokens,textInputTokens:result.textInputTokens??null,
        imageInputTokens:result.imageInputTokens??null,outputTokens:result.outputTokens,totalTokens:result.totalTokens,
        elapsedMs:Date.now()-task.createdAt,queueMs:started-task.createdAt,inferenceMs:Date.now()-started,...imageCost(request,result)};
      task.stage='saving';await this.state.storage.put('task',task);
      await this.env.GENERATIONS.put(objectKey,result.image);
      await this.finish(task,{state:'completed',objectKey,metrics:task.metrics});
    }catch(error){
      if(['saving','reporting'].includes(task.stage))throw error;
      await this.finish(task,{state:'failed',errorCode:error instanceof ImageProviderError?error.code:'provider_connection_failed',message:error instanceof ImageProviderError?error.message:'The image provider could not be reached.'});
    }
  }
  async alarm(){if(this.active)return this.active;this.active=this.run();try{return await this.active;}finally{this.active=null;}}
}
