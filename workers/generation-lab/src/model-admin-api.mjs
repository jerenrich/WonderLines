import {adminConfigured, adminOrigin, adminPrincipal, beginAdminLogin, finishAdminLogin, endAdminSession, CALLBACK_PATH} from './admin-auth.mjs';
import {handleSuspensionAdmin} from './suspension-admin-api.mjs';
import {readBoundedBody, RequestBodyTooLarge} from '../../shared/request-body.mjs';
const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const json=(value,status=200)=>Response.json(value,{status,headers:security});
const fail=(message,status,code='request_failed')=>json({error:{message,code}},status);
async function body(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new TypeError('JSON required');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request,73728)));
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new TypeError('Object required');
  return value;
}
export async function handleModelAdmin(request,env) {
  const url=new URL(request.url),path=url.pathname;
  try {
    if(path==='/api/admin/session'&&request.method==='GET') {
      const principal=await adminPrincipal(request,env);
      return json({configured:adminConfigured(env),authenticated:!!principal,...(principal?{email:principal.email,permissions:['models:read','models:write','models:rollback','accounts:read','accounts:suspend','accounts:reinstate']}:{})});
    }
    if(!adminConfigured(env))return fail('Google sign-in needs its OAuth client and session secret configured.',503,'auth_not_configured');
    if(url.origin!==adminOrigin(env))return fail('Use the configured admin website.',403,'invalid_origin');
    if([ '/api/admin/auth/start', CALLBACK_PATH ].includes(path)&&request.method==='GET') {
      if(!env.LOGIN_LIMITER)return fail('Sign-in protection is unavailable.',503);
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.headers.get('CF-Connecting-IP')??'unknown'));
      const key='model-admin:'+Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(!(await env.LOGIN_LIMITER.limit({key})).success)return fail('Too many sign-in attempts. Please wait a minute.',429);
      return path===CALLBACK_PATH?finishAdminLogin(request,env):beginAdminLogin(env,url.searchParams.get('destination'));
    }
    if(!['GET','POST'].includes(request.method))return fail('Method not allowed.',405);
    if(request.method==='POST'&&request.headers.get('Origin')!==url.origin)return fail('Please use this website to make the change.',403,'invalid_origin');
    if(path==='/api/admin/logout'&&request.method==='POST')return endAdminSession();
    const principal=await adminPrincipal(request,env);
    if(!principal)return fail('Sign in with your authorized Google account.',401,'unauthorized');
    if(path==='/api/admin/suspensions'||path.startsWith('/api/admin/accounts/')) {
      const response=await handleSuspensionAdmin(request,env,principal);
      return new Response(response.body,{status:response.status,headers:{...security,'Content-Type':'application/json'}});
    }
    if(!env.MODEL_ADMIN||!env.MODEL_REGISTRY)return fail('Model administration storage is not configured.',503,'storage_not_configured');
    let operation,input={};
    if(path==='/api/admin/models'&&request.method==='GET')operation='/current';
    else if(path==='/api/admin/models/history'&&request.method==='GET') {
      operation='/history';if(url.searchParams.has('before'))input.before=Number(url.searchParams.get('before'));
    } else if(/^\/api\/admin\/models\/versions\/[a-f0-9-]{36}$/.test(path)&&request.method==='GET') {
      operation='/version';input.id=path.split('/').at(-1);
    } else if(/^\/api\/admin\/models\/operations\/[a-f0-9-]{36}$/.test(path)&&request.method==='GET') {
      operation='/operation';input.id=path.split('/').at(-1);
    } else if(['/api/admin/models/validate','/api/admin/models/publish','/api/admin/models/rollback'].includes(path)&&request.method==='POST') {
      operation='/'+path.split('/').at(-1);input=await body(request);
    } else return fail('Not found.',404);
    const stub=env.MODEL_ADMIN.get(env.MODEL_ADMIN.idFromName('model-catalogue-v1'));
    const response=await stub.fetch('https://model-admin'+operation,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...input,actor:{id:principal.id,email:principal.email}})});
    return new Response(response.body,{status:response.status,headers:{...security,'Content-Type':'application/json'}});
  } catch(error) {
    if(error instanceof RequestBodyTooLarge)return fail('The catalogue request is too large.',413);
    if(error instanceof SyntaxError||error instanceof TypeError)return fail('Send a valid JSON object.',400);
    console.error(JSON.stringify({event:'model_admin_request_failed'}));
    return fail('Model administration is temporarily unavailable.',503,'admin_unavailable');
  }
}
