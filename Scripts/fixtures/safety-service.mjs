import worker, {Account, Budget} from '../../workers/coloring-sheets-api/src/index.mjs';
import {ADMIN_EMAIL} from '../../workers/shared/admin-identity.mjs';

export class Storage {
  values = new Map(); alarm = null; queue = Promise.resolve();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { if (Array.isArray(key)) return key.map(name => this.values.delete(name)); return this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async list({prefix = '', limit = Infinity, startAfter = ''} = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && key > startAfter).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([k,v]) => [k, structuredClone(v)]));
  }
  transaction(callback) {
    const work = this.queue.then(async () => {
      const before = structuredClone(this.values), alarm = this.alarm;
      try { const result = await callback(this); if (this.failCommit) { this.failCommit = false; throw Error('Synthetic storage commit failure'); } return result; } catch (error) { this.values = before; this.alarm = alarm; throw error; }
    });
    this.queue = work.catch(() => {}); return work;
  }
}
class Namespace {
  objects = new Map();
  constructor(type, env) { this.type = type; this.env = env; }
  idFromName(id) { return id; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new this.type({storage: new Storage(), waitUntil() {}}, this.env));
    return {fetch: (url, options) => this.objects.get(id).fetch(new Request(url, options))};
  }
}
export const actor = {id: 'verified-operator', email: ADMIN_EMAIL};
export const safe = () => ({answers: Object.fromEntries(['sexual', 'violence', 'hate', 'adult', 'frightening', 'bypass', 'all_ages'].map(name => [name, {type: 'noul', noul: name === 'all_ages' ? 1 : 0}]))});
export const invoke = (account, path, input = {}) => account.fetch(new Request('https://account' + path, {method: 'POST', body: JSON.stringify(input)}));
export function service() {
  const state = {verdict: 'allow', checks: 0};
  const env = {ACCOUNT_TOKEN_SECRET: 'synthetic-secret', OPENAI_API_KEY: 'synthetic', MODERATION_GATEWAY_ID: 'synthetic',
    FREE_DAILY_ALLOWANCE: '100', GLOBAL_DAILY_GENERATION_LIMIT: '10000', REGISTRATION_LIMITER: {limit: async () => ({success: true})},
    AI: {async run() { state.checks++; if (state.verdict === 'outage') throw Error('private upstream');
      const result = safe(); if (state.verdict === 'reject') result.answers.violence.noul = 1; if (state.verdict === 'uncertain') result.answers.all_ages.noul = 0; return result;}}};
  env.ACCOUNTS = new Namespace(Account, env); env.BUDGET = new Namespace(Budget, env);
  const images = new Map();
  env.GENERATIONS = {put: async (key, value) => images.set(key, value), get: async key => images.has(key) ? {body: new Response(images.get(key)).body} : null,
    delete: async keys => {for (const key of Array.isArray(keys) ? keys : [keys]) images.delete(key);},
    list: async ({prefix}) => ({objects: [...images.keys()].filter(key => key.startsWith(prefix)).map(key => ({key}))})};
  const register = async () => (await worker.fetch(new Request('https://test/v1/installations', {method: 'POST', headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1'}, body: '{}'}), env)).json();
  const request = (identity, path, options = {}) => worker.fetch(new Request('https://test' + path, {...options,
    headers: {Authorization: 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', ...options.headers}}), env);
  const generate = (identity, {id = crypto.randomUUID(), batchID = crypto.randomUUID(), legacy = false, queued = false} = {}) => request(identity, '/v1/generations', {
    method: 'POST', headers: {'Idempotency-Key': id, ...(queued ? {'X-Coloring-API-Version': '2'} : {})},
    body: JSON.stringify(legacy ? {subject: 'Synthetic example'} : {batchID, description: 'Synthetic example', age: 6, composition: 'front'})});
  const change = async (account, action, overrides = {}) => {
    const expectedVersion = (await (await invoke(account, '/admin/safety', {actor})).json()).version;
    return invoke(account, '/admin/safety/change', {actor, action, reason: 'Synthetic operator review', durationHours: 24, requestId: crypto.randomUUID(), expectedVersion, ...overrides});
  };
  return {env, state, images, register, request, generate, change};
}
