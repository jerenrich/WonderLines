// App Attest verification for the iOS generation boundary. No third-party runtime
// package or Apple network call is needed: Apple's public root is pinned here.
import {X509Certificate, createPublicKey, verify as verifySignature, createHash} from 'node:crypto';

// The bundled PEM below is Apple's
// Apple App Attestation Root CA (SHA-256 1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932).
const ROOT = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;
let cachedRoot;
const appRoot = () => cachedRoot ??= new X509Certificate(ROOT);
const utf8 = new TextEncoder();
const hash = value => new Uint8Array(createHash('sha256').update(value).digest());
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const concat = (...items) => Uint8Array.from(items.flatMap(item => [...item]));
const bytes = value => value instanceof Uint8Array;
export const b64url = value => Buffer.from(value).toString('base64url');
export function fromB64url(value, max = 16384) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > max * 4 / 3 + 4) throw Error('Invalid encoding');
  const result = new Uint8Array(Buffer.from(value, 'base64url'));
  if (result.length > max || b64url(result) !== value) throw Error('Invalid encoding');
  return result;
}

// Small strict CBOR reader for the WebAuthn/App Attest maps. Reject trailing data,
// indefinite lengths, duplicate keys and oversized nesting rather than guessing.
function parseCBOR(input, exact = true) {
  const data = new Uint8Array(input); let offset = 0;
  function read(depth) {
    if (depth > 12 || offset >= data.length) throw Error('Invalid CBOR');
    const head = data[offset++], major = head >> 5, additional = head & 31;
    let length;
    if (additional < 24) length = additional;
    else if (additional === 24) { if (offset + 1 > data.length) throw Error('Invalid CBOR'); length = data[offset++]; }
    else if (additional === 25) { if (offset + 2 > data.length) throw Error('Invalid CBOR'); length = (data[offset++] << 8) | data[offset++]; }
    else if (additional === 26) { if (offset + 4 > data.length) throw Error('Invalid CBOR'); length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0); offset += 4; }
    else throw Error('Invalid CBOR');
    if (length > 65536) throw Error('Invalid CBOR');
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2 || major === 3) {
      if (offset + length > data.length) throw Error('Invalid CBOR');
      const part = data.slice(offset, offset + length); offset += length;
      return major === 2 ? part : new TextDecoder('utf-8', {fatal: true}).decode(part);
    }
    if (major === 4) return Array.from({length}, () => read(depth + 1));
    if (major === 5) {
      const map = new Map();
      for (let i = 0; i < length; i++) { const key = read(depth + 1); if (map.has(key)) throw Error('Invalid CBOR'); map.set(key, read(depth + 1)); }
      return map;
    }
    throw Error('Invalid CBOR');
  }
  const value = read(0); if (exact && offset !== data.length) throw Error('Invalid CBOR'); return {value, offset};
}
export function decodeCBOR(input) { return parseCBOR(input).value; }
function der(data, start) {
  if (start + 2 > data.length) throw Error('Invalid DER');
  const tag = data[start], first = data[start + 1]; let size = first, head = 2;
  if (first & 128) {
    const count = first & 127; if (!count || count > 4 || start + 2 + count > data.length) throw Error('Invalid DER');
    size = 0; for (let i = 0; i < count; i++) size = size * 256 + data[start + 2 + i]; head += count;
  }
  const begin = start + head, end = begin + size;
  if (end > data.length) throw Error('Invalid DER'); return {tag, begin, end};
}
function children(data, item) {
  const result = []; let offset = item.begin;
  while (offset < item.end) { const child = der(data, offset); result.push(child); offset = child.end; }
  if (offset !== item.end) throw Error('Invalid DER'); return result;
}
const NONCE_OID = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);
function certNonce(cert) {
  const data = new Uint8Array(cert.raw), outer = der(data, 0);
  if (outer.tag !== 0x30 || outer.end !== data.length) throw Error('Invalid certificate');
  const tbs = children(data, outer)[0];
  const extensions = children(data, tbs).find(child => child.tag === 0xa3);
  if (!extensions) throw Error('Missing extensions');
  const sequence = children(data, extensions)[0];
  for (const ext of children(data, sequence)) {
    const fields = children(data, ext);
    if (fields[0]?.tag !== 0x06 || !equal(data.slice(fields[0].begin, fields[0].end), NONCE_OID)) continue;
    const value = fields.at(-1); if (value?.tag !== 0x04) break;
    const inner = data.slice(value.begin, value.end), seq = der(inner, 0);
    if (seq.tag !== 0x30 || seq.end !== inner.length) break;
    const octet = children(inner, seq);
    const wrapped = octet.length === 1 && octet[0].tag === 0xa1 ? children(inner, octet[0]) : octet;
    if (wrapped.length === 1 && wrapped[0].tag === 0x04) return inner.slice(wrapped[0].begin, wrapped[0].end);
  }
  throw Error('Missing nonce');
}
function certificateChain(x5c) {
  if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every(c => bytes(c) && c.length < 8192)) throw Error('Invalid certificate chain');
  const leaf = new X509Certificate(x5c[0]), intermediate = new X509Certificate(x5c[1]), root = appRoot();
  const now = Date.now();
  for (const cert of [leaf, intermediate, root]) if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) throw Error('Expired certificate');
  if (leaf.ca || !intermediate.ca || !root.ca || !leaf.checkIssued(intermediate) || !intermediate.checkIssued(root) ||
      !leaf.verify(intermediate.publicKey) || !intermediate.verify(root.publicKey)) throw Error('Invalid certificate chain');
  return leaf;
}
function appHash(appID) {
  if (!/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(appID)) throw Error('Invalid App ID');
  return hash(utf8.encode(appID));
}
function rp(authData, appID) {
  if (authData.length < 37 || !equal(authData.slice(0, 32), appHash(appID))) throw Error('Invalid RP ID');
  return new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
}
export function verifyAttestation(attestation, keyID, challenge, appID, environment) {
  return verifyAttestationHash(attestation, keyID, hash(utf8.encode(challenge)), appID, environment);
}
// Separate the documented clientDataHash input so Apple's published sample can
// exercise every certificate and authenticator check. That sample passed raw
// challenge bytes as clientDataHash; the live app correctly passes SHA-256.
export function verifyAttestationHash(attestation, keyID, clientDataHash, appID, environment) {
  const object = decodeCBOR(fromB64url(attestation));
  if (!(object instanceof Map) || object.get('fmt') !== 'apple-appattest') throw Error('Invalid attestation');
  const statement = object.get('attStmt'), authData = object.get('authData');
  if (!(statement instanceof Map) || !bytes(authData) || authData.length < 88 || !bytes(statement.get('receipt'))) throw Error('Invalid attestation');
  const leaf = certificateChain(statement.get('x5c'));
  const nonce = hash(concat(authData, clientDataHash));
  if (!equal(certNonce(leaf), nonce)) throw Error('Invalid nonce');
  const jwk = leaf.publicKey.export({format: 'jwk'});
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw Error('Invalid key type');
  const point = concat([4], fromB64url(jwk.x, 32), fromB64url(jwk.y, 32));
  const keyBytes = fromB64url(keyID, 32);
  if (keyBytes.length !== 32 || !equal(hash(point), keyBytes)) throw Error('Invalid key identifier');
  if (rp(authData, appID) !== 0 || !(authData[32] & 0x40)) throw Error('Invalid authenticator data');
  const aaguid = authData.slice(37, 53), production = concat(utf8.encode('appattest'), new Uint8Array(7));
  const allowed = environment === 'production' ? [production] : environment === 'development'
    ? [utf8.encode('appattestdevelop'), utf8.encode('appattestsandbox')] : [];
  if (!allowed.some(value => equal(aaguid, value))) throw Error('Invalid environment');
  const length = (authData[53] << 8) | authData[54];
  if (length !== 32 || !equal(authData.slice(55, 87), keyBytes)) throw Error('Invalid credential ID');
  // The COSE key is bound by Apple's certificate; reject malformed trailing data.
  const parsed = parseCBOR(authData.slice(87), false), cose = parsed.value;
  if (87 + parsed.offset < authData.length || (authData[32] & 0x80)) {
    const extensions = decodeCBOR(authData.slice(87 + parsed.offset));
    if (!(extensions instanceof Map)) throw Error('Invalid extensions');
    const category = extensions.get('apple_validation_category_01');
    const version = extensions.get('apple_bundle_version_01');
    if (!bytes(category) || category.length !== 4 || ![1, 2, 3, 4, 5, 6, 10].includes(new DataView(category.buffer, category.byteOffset, 4).getUint32(0, true))) throw Error('Invalid validation category');
    if (typeof version !== 'string' || !version.length || version.length > 64) throw Error('Invalid bundle version');
  } else if (87 + parsed.offset !== authData.length) throw Error('Invalid authenticator data');
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1 ||
      !equal(cose.get(-2), fromB64url(jwk.x, 32)) || !equal(cose.get(-3), fromB64url(jwk.y, 32))) throw Error('Invalid COSE key');
  return {keyID, publicKey: leaf.publicKey.export({format: 'pem', type: 'spki'}), counter: 0, seen: '0'};
}
export function verifyAssertion(assertion, clientData, publicKey, appID) {
  const object = decodeCBOR(fromB64url(assertion, 2048));
  const authData = object instanceof Map && object.get('authenticatorData'), signature = object instanceof Map && object.get('signature');
  if (!bytes(authData) || authData.length < 37 || authData.length > 1024 ||
      !bytes(signature) || !signature.length || signature.length > 128) throw Error('Invalid assertion');
  // iOS 27 appends signed WebAuthn extensions after the 37-byte core. Older
  // assertions have no extension flag and must end exactly at byte 37.
  const hasExtensions = Boolean(authData[32] & 0x80);
  if (authData[32] & 0x40 || hasExtensions === (authData.length === 37)) throw Error('Invalid assertion extensions');
  if (hasExtensions) {
    const extensions = decodeCBOR(authData.slice(37));
    if (!(extensions instanceof Map)) throw Error('Invalid assertion extensions');
    const category = extensions.get('apple_validation_category_01');
    const version = extensions.get('apple_bundle_version_01');
    if (!bytes(category) || category.length !== 4 ||
        ![1, 2, 3, 4, 5, 6, 10].includes(new DataView(category.buffer, category.byteOffset, 4).getUint32(0, true)) ||
        typeof version !== 'string' || !version.length || version.length > 64) throw Error('Invalid assertion extensions');
  }
  const counter = rp(authData, appID);
  if (!counter) throw Error('Invalid assertion counter');
  if (!verifySignature('sha256', concat(authData, hash(clientData)), createPublicKey(publicKey), signature)) throw Error('Invalid assertion signature');
  return counter;
}
export function acceptCounter(record, counter) {
  // A 64-counter window tolerates parallel five-sheet batches arriving out of
  // order. The persisted bitmap rejects replay without one DO key per request.
  const high = record.counter, seen = BigInt(record.seen || '0');
  if (counter > high) {
    const shift = counter - high;
    return {...record, counter, seen: (((seen << BigInt(Math.min(shift, 64))) | 1n) & ((1n << 64n) - 1n)).toString()};
  }
  const delta = high - counter;
  if (delta >= 64 || (seen & (1n << BigInt(delta)))) throw Error('Replayed assertion');
  return {...record, seen: (seen | (1n << BigInt(delta))).toString()};
}
