import assert from 'node:assert/strict';
import {SignJWT,generateKeyPair,exportJWK,createLocalJWKSet} from 'jose';
import worker from '../src/index.mjs';
import {ADMIN_EMAIL,adminPrincipal,comparisonPrincipal,verifyGoogleIdentity,beginAdminLogin,adminConfigured} from '../src/admin-auth.mjs';
import {createSession} from '../src/auth.mjs';

const origin='https://admin.example';
const env={MODEL_ADMIN_ORIGIN:origin,GOOGLE_CLIENT_ID:'synthetic-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-google-secret',MODEL_ADMIN_SESSION_SECRET:'synthetic-admin-session-secret-at-least-32-characters',LOGIN_LIMITER:{limit:async()=>({success:true})},ASSETS:{fetch:async()=>new Response('Login shell')}};
const request=(path,method='GET',input,cookie,headers={})=>new Request(origin+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...headers},...(input!==undefined?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
assert.equal(adminConfigured(env),true);
assert.equal(adminConfigured({...env,GOOGLE_CLIENT_SECRET:undefined}),false);
assert.equal(adminConfigured({...env,MODEL_ADMIN_ORIGIN:'https://admin.example/path'}),false);
assert.equal(adminConfigured({...env,MODEL_ADMIN_SESSION_SECRET:'short'}),false);
let response=await worker.fetch(request('/api/admin/session'),{});
assert.deepEqual(await response.json(),{configured:false,authenticated:false});
response=await worker.fetch(request('/api/admin/auth/start'),{});assert.equal(response.status,503);
for(const path of ['/api/admin/models','/api/admin/models/history','/api/admin/models/versions/'+crypto.randomUUID()])assert.equal((await worker.fetch(request(path),env)).status,401);
const studio=await createSession({LAB_ACCESS_KEY:'studio-only'},false);
assert.equal((await worker.fetch(request('/api/admin/models','GET',undefined,studio),{...env,LAB_ACCESS_KEY:'studio-only'})).status,401,'Comparison access keys never grant admin rights.');
assert.equal((await worker.fetch(request('/api/admin/models/publish','POST',{},null,{Origin:'https://evil.example'}),env)).status,403);
assert.equal((await worker.fetch(request('/api/admin/auth/start'),{...env,LOGIN_LIMITER:{limit:async()=>({success:false})}})).status,429);

const {privateKey,publicKey}=await generateKeyPair('RS256',{extractable:true});
const jwk={...await exportJWK(publicKey),kid:'synthetic-google-key',alg:'RS256',use:'sig'};
const localKeys=createLocalJWKSet({keys:[jwk]});
const claims={email:ADMIN_EMAIL,email_verified:true,nonce:'expected-nonce'};
const token=async(overrides={},options={})=>new SignJWT({...claims,...overrides}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
  .setIssuer(options.issuer??'https://accounts.google.com').setAudience(options.audience??env.GOOGLE_CLIENT_ID)
  .setSubject('google-user-123').setIssuedAt().setExpirationTime(options.expiration??'5m').sign(privateKey);
assert.deepEqual(await verifyGoogleIdentity(await token(),env,'expected-nonce',localKeys),{id:'google-user-123',email:ADMIN_EMAIL});
for(const [overrides,options] of [[{email:'another@gmail.com'},{}],[{email_verified:false},{}],[{email_verified:'true'},{}],[{nonce:'wrong'},{}],[{azp:'another-client'},{}],[{}, {issuer:'https://evil.example'}],[{}, {audience:'another-client'}],[{}, {audience:[env.GOOGLE_CLIENT_ID,'another-client']}],[{}, {expiration:1}]]) {
  await assert.rejects(verifyGoogleIdentity(await token(overrides,options),env,'expected-nonce',localKeys));
}
assert.equal((await verifyGoogleIdentity(await token({azp:env.GOOGLE_CLIENT_ID},{audience:[env.GOOGLE_CLIENT_ID,'another-client']}),env,'expected-nonce',localKeys)).email,ADMIN_EMAIL);
await assert.rejects(verifyGoogleIdentity((await token()).slice(0,-8)+'invalid',env,'expected-nonce',localKeys));
const unsigned=Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.';
await assert.rejects(verifyGoogleIdentity(unsigned,env,'expected-nonce',localKeys));

const originalFetch=globalThis.fetch;
let exchanges=0,keyReads=0,currentNonce,expectedVerifier;
globalThis.fetch=async(url,options={})=>{
  if(String(url)==='https://www.googleapis.com/oauth2/v3/certs'){keyReads++;return Response.json({keys:[jwk]},{headers:{'Cache-Control':'public,max-age=3600'}});}
  assert.equal(String(url),'https://oauth2.googleapis.com/token');exchanges++;
  const body=new URLSearchParams(options.body);
  assert.equal(body.get('client_secret'),env.GOOGLE_CLIENT_SECRET);
  assert.equal(body.get('redirect_uri'),origin+'/api/admin/auth/callback');
  assert.equal(body.get('grant_type'),'authorization_code');
  const verifier=body.get('code_verifier');
  const actual=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  assert.equal(actual,expectedVerifier);
  assert.equal(options.redirect,'manual');
  return Response.json({id_token:await token({nonce:currentNonce}),access_token:'never-store-this-access-token'});
};
try {
  response=await worker.fetch(request('/api/admin/auth/start'),env);
  assert.equal(response.status,303);
  const location=new URL(response.headers.get('Location'));
  assert.equal(location.origin,'https://accounts.google.com');
  assert.equal(location.searchParams.get('scope'),'openid email');
  assert.equal(location.searchParams.get('code_challenge_method'),'S256');
  assert.equal(location.searchParams.get('login_hint'),ADMIN_EMAIL);
  assert.ok(!location.href.includes(env.GOOGLE_CLIENT_SECRET));
  currentNonce=location.searchParams.get('nonce');expectedVerifier=location.searchParams.get('code_challenge');
  const flow=response.headers.get('Set-Cookie').split(';')[0];
  assert.match(response.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  response=await worker.fetch(request('/api/admin/auth/callback?state=wrong&code=code','GET',undefined,flow),env);
  assert.equal(response.headers.get('Location'),'/admin/models?login=failed');assert.equal(exchanges,0);
  response=await worker.fetch(request('/api/admin/auth/callback?state='+location.searchParams.get('state')+'&code=code','GET',undefined,flow),env);
  assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/admin/models');
  const cookies=response.headers.getSetCookie();
  const session=cookies.find(value=>value.startsWith('__Host-wonderlines_admin='));
  assert.match(session,/HttpOnly; Secure; SameSite=Strict; Max-Age=28800/);
  assert.ok(!cookies.join('').includes('never-store-this-access-token'));
  const cookie=session.split(';')[0];
  assert.equal((await adminPrincipal(request('/api/admin/models','GET',undefined,cookie),env)).email,ADMIN_EMAIL);
  assert.equal(await adminPrincipal(request('/api/admin/models','GET',undefined,cookie),{...env,MODEL_ADMIN_SESSION_SECRET:'rotated-admin-secret-at-least-32-characters'}),null);
  assert.equal(await adminPrincipal(request('/api/admin/models','GET',undefined,cookie+'x'),env),null);
  response=await worker.fetch(request('/api/admin/session','GET',undefined,cookie),env);
  const authenticated=await response.json();assert.equal(authenticated.email,ADMIN_EMAIL);assert.ok(authenticated.permissions.includes('models:rollback'));
  response=await worker.fetch(request('/api/admin/logout','POST',{},cookie,{Origin:'https://evil.example'}),env);assert.equal(response.status,403);
  response=await worker.fetch(request('/api/admin/logout','POST',{},cookie),env);assert.equal(response.status,200);assert.match(response.headers.get('Set-Cookie'),/Max-Age=0/);
  // Expired or fabricated owner sessions are never accepted, even with the
  // allowed email and the comparison key.
  const expired=await new SignJWT({purpose:'session',email:ADMIN_EMAIL}).setProtectedHeader({alg:'HS256'}).setIssuer('wonderlines-model-admin').setAudience(env.GOOGLE_CLIENT_ID).setSubject('owner').setIssuedAt(1).setExpirationTime(2).sign(new TextEncoder().encode(env.MODEL_ADMIN_SESSION_SECRET));
  assert.equal(await adminPrincipal(request('/api/admin/models','GET',undefined,'__Host-wonderlines_admin='+expired),env),null);
  const wrongUser=await new SignJWT({purpose:'session',email:'other@gmail.com'}).setProtectedHeader({alg:'HS256'}).setIssuer('wonderlines-model-admin').setAudience(env.GOOGLE_CLIENT_ID).setSubject('other').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(env.MODEL_ADMIN_SESSION_SECRET));
  assert.equal(await adminPrincipal(request('/api/admin/models','GET',undefined,'__Host-wonderlines_admin='+wrongUser),env),null);
  response=await worker.fetch(request('/api/admin/auth/start?destination=comparison'),env);
  const compareLocation=new URL(response.headers.get('Location'));
  currentNonce=compareLocation.searchParams.get('nonce');expectedVerifier=compareLocation.searchParams.get('code_challenge');
  const compareFlow=response.headers.get('Set-Cookie').split(';')[0];
  response=await worker.fetch(request('/api/admin/auth/callback?state='+compareLocation.searchParams.get('state')+'&code=code','GET',undefined,compareFlow),env);
  assert.equal(response.headers.get('Location'),'/');
  const compareCookie=response.headers.getSetCookie().find(value=>value.startsWith('__Host-wonderlines_compare_google=')).split(';')[0];
  assert.equal((await comparisonPrincipal(request('/','GET',undefined,compareCookie),env)).email,ADMIN_EMAIL);
  assert.equal(await adminPrincipal(request('/','GET',undefined,compareCookie),env),null);
  assert.equal(await comparisonPrincipal(request('/','GET',undefined,cookie),env),null);
  assert.equal(exchanges,2);assert.equal(keyReads,1);
} finally {globalThis.fetch=originalFetch;}
console.log('PASS: Google code/PKCE flow, signed state and nonce, RS256 identity validation, owner allowlist, separate sessions, CSRF, expiry, rotation and no token persistence; no network.');
