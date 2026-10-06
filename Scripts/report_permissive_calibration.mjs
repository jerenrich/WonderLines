// Offline, reproducible evaluation of recorded live scores. No API calls.
import {readFileSync,writeFileSync} from 'node:fs';
import {MODERATION_MODELS,MODERATION_POLICY,moderationThresholds,moderationAssessment} from '../workers/coloring-sheets-api/src/moderation.mjs';
const read=p=>JSON.parse(readFileSync(new URL('../'+p,import.meta.url),'utf8'));
const fixtures=['moderation-cases','moderation-validation-cases','moderation-clef-calibration-cases','moderation-permissive-cases','moderation-car-regressions'].flatMap(n=>read('Scripts/fixtures/'+n+'.json'));
const descriptions=new Map(fixtures.map(x=>[x.name,x.description]));
const sources=['2026-10-04-clef-v5-validation','2026-10-04-clef-calibration-holdout','2026-10-06-clef-permissive-live','2026-10-06-clef-car-regressions'];
const datasets=Object.fromEntries(sources.map(n=>[n,read('docs/moderation/'+n+'.json').results.map(x=>({...x,description:x.description??descriptions.get(x.name)}))]));
const baseline={all_ages:.73,sexual:.30,violence:.30,hate:.30,adult:.30,frightening:.30,bypass:.51};
const thresholds=moderationThresholds(MODERATION_MODELS.clef);
const rejectedBroaderProfile={all_ages:.20,sexual:.85,violence:.65,hate:.60,adult:.65,frightening:.60,bypass:.70};
const decision=(s,t)=>s.all_ages>=t.all_ages&&Object.entries(t).every(([k,v])=>k==='all_ages'||s[k]<=v);
function evaluate(rows,t){
 const valid=rows.filter(x=>x.scores),accepted=valid.filter(x=>decision(x.scores,t));
 const falsePositives=valid.filter(x=>x.expected&&!decision(x.scores,t));
 const falseNegatives=accepted.filter(x=>!x.expected);
 return {evaluations:rows.length,unavailable:rows.length-valid.length,harmless:valid.filter(x=>x.expected).length,harmlessApproved:accepted.filter(x=>x.expected).length,unsafe:valid.filter(x=>!x.expected).length,unsafeApproved:falseNegatives.length,falsePositives,falseNegatives,approvedPrompts:accepted.map(({name,description,expected})=>({name,description,expected}))};
}
const all=Object.values(datasets).flat();
for(const row of all.filter(x=>x.scores)){
 const response={answers:Object.fromEntries(Object.entries(row.scores).map(([k,noul])=>[k,{type:'noul',noul}]))};
 if(moderationAssessment(response,MODERATION_MODELS.clef).allowed!==decision(row.scores,thresholds))throw Error('Worker differs from report');
}
const report={date:'2026-10-06',policy:MODERATION_POLICY,model:MODERATION_MODELS.clef,method:'Threshold-only calibration. Historical scores and 80 new calibration cases guide selection; 40 additional validation cases and six repeated user car regressions assess the profile. One result per case except explicitly repeated car prompts; validation examples were inspected during analysis, not a blinded study. Jev and Clef-flash profiles unchanged. Scores are not calibrated probabilities. Recorded cases do not guarantee future safety or approvals.',thresholds,baseline,rejectedBroaderProfile,baselineSummary:evaluate(all,baseline),summary:evaluate(all,thresholds),broaderProfileSummary:evaluate(all,rejectedBroaderProfile),datasets:Object.fromEntries(Object.entries(datasets).map(([n,r])=>[n,evaluate(r,thresholds)]))};
const out=process.argv.find(x=>x.startsWith('--output='))?.slice(9);
if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({thresholds,baseline:{harmlessApproved:report.baselineSummary.harmlessApproved,harmless:report.baselineSummary.harmless,unsafeApproved:report.baselineSummary.unsafeApproved},calibrated:{harmlessApproved:report.summary.harmlessApproved,harmless:report.summary.harmless,unsafe:report.summary.unsafe,unsafeApproved:report.summary.unsafeApproved,remainingHarmlessBlocks:report.summary.falsePositives.map(x=>x.description)},broaderMisses:report.broaderProfileSummary.falseNegatives.map(x=>x.description)},null,2));
