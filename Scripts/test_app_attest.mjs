import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import worker, {Account} from '../workers/coloring-sheets-api/src/index.mjs';
import {verifyAssertion, verifyAttestationHash, acceptCounter, decodeCBOR, b64url} from '../workers/coloring-sheets-api/src/app-attest.mjs';

const sha = value => createHash('sha256').update(value).digest();
// Apple's published validation fixture (developer.apple.com/documentation/devicecheck/attestation-object-validation-guide) is dated April 2026. It passes raw
// challenge bytes as clientDataHash despite the live API requiring SHA-256.
const published = readFileSync(new URL('./fixtures/apple-app-attestation.txt', import.meta.url), 'utf8').trim()
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const publishedKey = 'zgSY9YSD-7TaDXssY6WlOPVS1K3Lmk-pFhlcSWE-ZV0';
const actualNow = Date.now;
try {
  Date.now = () => Date.parse('2026-04-21T00:00:00Z');
  const verified = verifyAttestationHash(published, publishedKey, Buffer.from('example_server_challenge'),
    '1234567890.com.example.myapp', 'production');
  assert.equal(verified.keyID, publishedKey);
  assert.match(verified.publicKey, /BEGIN PUBLIC KEY/);
  assert.throws(() => verifyAttestationHash(published, publishedKey, Buffer.from('changed'),
    '1234567890.com.example.myapp', 'production'));
  assert.throws(() => verifyAttestationHash(published, publishedKey, Buffer.from('example_server_challenge'),
    '1234567890.other.app', 'production'));
} finally { Date.now = actualNow; }

const appID = 'ABCDEFGHIJ.com.jordan.family.ColoringSheets';
const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const pem = publicKey.export({type: 'spki', format: 'pem'});
function cbor(value) {
  function head(type, count) { return count < 24 ? Buffer.from([(type << 5) | count]) : count < 256 ? Buffer.from([(type << 5) | 24, count]) : Buffer.from([(type << 5) | 25, count >> 8, count & 255]); }
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw Error('Unsupported test CBOR');
}
function assertion(counter, clientData) {
  const auth = Buffer.alloc(37); sha(appID).copy(auth); auth[32] = 1; auth.writeUInt32BE(counter, 33);
  const signature = sign('sha256', Buffer.concat([auth, sha(clientData)]), privateKey);
  return b64url(cbor(new Map([['authenticatorData', auth], ['signature', signature]])));
}
const data = Buffer.from('one use');
const proof = assertion(1, data);
assert.equal(verifyAssertion(proof, data, pem, appID), 1);
assert.throws(() => verifyAssertion(proof, Buffer.from('changed'), pem, appID));
assert.throws(() => verifyAssertion(proof, data, pem, 'ABCDEFGHIJ.other.app'));
assert.throws(() => decodeCBOR(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02])), /Invalid CBOR/);
let record = {counter: 0, seen: '0'};
record = acceptCounter(record, 2); record = acceptCounter(record, 1);
assert.throws(() => acceptCounter(record, 1), /Replayed/);
record = acceptCounter(record, 70); assert.throws(() => acceptCounter(record, 2), /Replayed/);

class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
}
class Accounts {
  objects = new Map();
  constructor(env) { this.env = env; }
  idFromName(id) { return id; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new Account({storage: new Storage()}, this.env));
    return {fetch: (request, init) => this.objects.get(id).fetch(new Request(request, init))};
  }
}
const env = {ACCOUNT_TOKEN_SECRET: 'local-test-secret', APP_ATTEST_APP_ID: appID,
  APP_ATTEST_ENVIRONMENT: 'production', APP_ATTEST_ENFORCE: 'true'};
env.ACCOUNTS = new Accounts(env);
const base = 'https://example.test';
const registered = await worker.fetch(new Request(base + '/v1/installations', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}), env);
const account = await registered.json();
const auth = {'Authorization': 'Bearer ' + account.accessToken};
const challengeResponse = await worker.fetch(new Request(base + '/v1/app-attest/challenge', {
  method: 'POST', headers: {...auth, 'Content-Type': 'application/json'}, body: '{"purpose":"assertion"}'
}), env);
assert.equal(challengeResponse.status, 200);
const challenge = (await challengeResponse.json()).challenge;
const id = crypto.randomUUID(), body = JSON.stringify({subject: 'A flower'});
const clientData = Buffer.from(JSON.stringify({challenge, method: 'POST', path: '/v1/generations',
  idempotencyKey: id, bodySHA256: b64url(sha(body))}));
const makeRequest = (signedBody = body, signedProof = assertion(1, clientData)) => new Request(base + '/v1/generations', {
  method: 'POST', headers: {...auth, 'Content-Type': 'application/json', 'Idempotency-Key': id,
    'X-App-Attest-Client-Data': b64url(clientData), 'X-App-Attest-Assertion': signedProof}, body: signedBody
});
assert.equal((await worker.fetch(makeRequest('tampered'), env)).status, 403);
assert.equal((await worker.fetch(new Request(base + '/v1/generations', {method: 'POST',
  headers: {...auth, 'Content-Type': 'application/json', 'Idempotency-Key': id}, body}), env)).status, 403);
const object = env.ACCOUNTS.objects.get(account.accountId);
await object.state.storage.put('app-attest', {keyID: 'test', publicKey: pem, counter: 0, seen: '0'});
const accountState = await object.state.storage.get('account');
await object.state.storage.put('account', {...accountState, appAttested: true});
const enrolledStatus = await worker.fetch(new Request(base + '/v1/app-attest/status', {headers: auth}), env);
assert.deepEqual(await enrolledStatus.json(), {keyID: 'test'});

assert.equal((await worker.fetch(makeRequest(), env)).status, 503, 'Valid assertion reaches configuration checks.');
assert.equal((await worker.fetch(makeRequest(), env)).status, 403, 'Replay fails before provider or budget checks.');
assert.equal((await object.state.storage.get('app-attest')).counter, 1);
assert.equal((await worker.fetch(new Request(base + '/v1/app-attest/attest', {
  method: 'POST', headers: {...auth, 'Content-Type': 'application/json'},
  body: JSON.stringify({challenge, keyID: 'bad', attestation: 'bad'})
}), env)).status, 403, 'Assertion challenge cannot be used for attestation.');
console.log('PASS: App Attest assertion signature, request binding, account policy, replay window, and challenge scope; no network.');
