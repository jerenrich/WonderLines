// Opt-in billed text checks; save validated scores for offline threshold fitting.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {MODERATION_MODELS,MODERATION_POLICY,moderationInput,moderationScores,moderationAssessment} from '../workers/coloring-sheets-api/src/moderation.mjs';
const arg=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.split('=').slice(1).join('=');
if(!process.argv.includes('--live')||!arg('fixture')||!arg('output'))throw Error('Use --live --fixture=path --output=path [--model=clef]');
const name=arg('model')??'clef',model=MODERATION_MODELS[name];if(!model)throw Error('Unknown model');
const cases=JSON.parse(await readFile(arg('fixture'),'utf8'));
const require=createRequire(import.meta.url);
const {getPlatformProxy}=require(process.env.WRANGLER_MODULE??'wrangler');
const proxy=await getPlatformProxy({configPath:process.env.MODERATION_PROXY_CONFIG,persist:false,remoteBindings:true});
const results=[];
try{
 for(const test of cases){
  const started=Date.now();
  try{
   const value=await proxy.env.AI.run(model,moderationInput(test.description,model),{gateway:{id:'coloring-sheets',skipCache:true,collectLog:true}});
   const row={...test,expected:test.allowed,...moderationAssessment(value,model),scores:moderationScores(value),elapsedMs:Date.now()-started};
   results.push(row);console.log(JSON.stringify({name:test.name,expected:row.expected,allowed:row.allowed,scores:row.scores}));
  }catch{results.push({...test,expected:test.allowed,allowed:null,error:'unavailable',elapsedMs:Date.now()-started});console.log(JSON.stringify({name:test.name,error:'unavailable'}));}
  await writeFile(arg('output'),JSON.stringify({policy:MODERATION_POLICY,model,results},null,2)+'\n');
 }
}finally{await proxy.dispose();}
