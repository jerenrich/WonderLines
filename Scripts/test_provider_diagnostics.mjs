import assert from 'node:assert/strict';
import {runImageRequest} from '../workers/coloring-sheets-api/src/image-provider.mjs';

// Exercise the real response reader and classifier with prompt echoes, hostile
// fields, malformed/oversized responses and failures behind HTTP 200. No network.
const originalFetch=globalThis.fetch;
const privateText='PRIVATE-PROMPT dinosaur delivering pizza PRIVATE-API-KEY';
const cases=[
  ['AiError: Model input is not valid: missing required input mask_image', ['missing_required_input','invalid_model_input'],['mask_image']],
  ['This model does not support request queuing', ['unsupported_queue'],[]],
  ['Inference error: CUDA out of memory', ['out_of_memory','inference_failed'],[]],
  ['Inference error: tensor shape mismatch', ['inference_failed','tensor_shape_mismatch'],[]],
  ['Response was flagged by NSFW check', ['safety_rejected'],[]],
  ['Capacity temporarily exceeded, please try again', ['capacity_exceeded'],[]],
  ['Inference timeout: deadline exceeded', ['provider_timeout'],[]],
  ['width must be a multiple of 16', ['invalid_dimensions'],[]],
  ['prompt is too long', ['prompt_too_long'],[]],
  ['Invalid parameter width', ['invalid_model_input'],['width']],
  ['Invalid parameter PRIVATE_API_KEY', ['invalid_model_input'],[]],
  ['Unknown failure '+privateText, [],[]],
];
try {
  for(const [message,reasons,parameters] of cases) {
    globalThis.fetch=async()=>Response.json({errors:[{code:3030,message:message+' '+privateText,param:'PRIVATE-API-KEY',data:{prompt:privateText}}]},
      {status:400,headers:{'cf-aig-log-id':'01234567-89ab-cdef-0123-456789abcdef'}});
    await assert.rejects(runImageRequest({url:'https://synthetic.invalid',payload:{prompt:privateText},headers:{},provider:'workers-ai'}),error=>{
      assert.deepEqual(error.diagnostics.upstreamErrorReasons,reasons);
      assert.deepEqual(error.diagnostics.upstreamErrorParameters,parameters);
      assert.equal(error.diagnostics.upstreamErrorDetailStatus,reasons.length?'classified':'unclassified');
      assert.deepEqual(error.diagnostics.upstreamErrorCodes,['3030']);
      assert.equal(error.diagnostics.gatewayRequestID,'01234567-89ab-cdef-0123-456789abcdef');
      assert.ok(!JSON.stringify({message:error.message,diagnostics:error.diagnostics}).includes('PRIVATE'));
      return true;
    });
  }
  // Multiple error envelopes, including FastAPI field locations, must never
  // retain free-form parameter names, messages, input objects or secret values.
  globalThis.fetch=async()=>Response.json({success:false,errors:[{code:8007,message:'This model does not support request queuing'}],
    detail:[{loc:['body','width',privateText],msg:'validation error',input:privateText}]});
  await assert.rejects(runImageRequest({url:'https://synthetic.invalid',payload:{},provider:'workers-ai'}),error=>{
    assert.deepEqual(error.diagnostics.upstreamErrorReasons,['unsupported_queue','invalid_model_input']);
    assert.deepEqual(error.diagnostics.upstreamErrorParameters,['width']);
    assert.ok(!JSON.stringify(error.diagnostics).includes('PRIVATE'));return true;
  });
  for(const body of ['not JSON '+privateText,JSON.stringify({errors:[{message:privateText.repeat(2000)}]})]) {
    globalThis.fetch=async()=>new Response(body,{status:400});
    await assert.rejects(runImageRequest({url:'https://synthetic.invalid',payload:{},provider:'workers-ai'}),error=>{
      assert.equal(error.diagnostics.upstreamErrorDetailStatus,'unavailable');
      assert.ok(!JSON.stringify(error.diagnostics).includes('PRIVATE'));return true;
    });
  }
} finally {globalThis.fetch=originalFetch;}
console.log('PASS: provider failure causes and safe parameter names survive response parsing; prompts, keys, raw messages, oversized bodies and unknown text remain private; no network.');
