import { LEASE_KIND, requireLeaseBuild } from './lease-peer.js';
import { bufferedReader } from './link.js';

const encode = new TextEncoder();
const decode = new TextDecoder('utf-8', { fatal: true });
const messages = {
  E_PENDING: 'Waiting for the owner or the paired lease-only link.',
  E_SCOPE: 'Outside the approved scope.',
  E_EXPIRED: 'This lease has expired.',
  E_REVOKED: 'This lease is no longer active.',
  E_DENIED: 'The owner declined the request.',
  E_UNSUPPORTED: 'This operation is unavailable on the lease route.',
  E_UNAVAILABLE: 'The lease link is unavailable.',
  E_OUTCOME_UNKNOWN: 'The action may have taken effect. Do not retry it automatically.',
};

export function refusal(reason) {
  const code = Object.hasOwn(messages, reason) ? reason : 'E_UNAVAILABLE';
  return Object.assign(new Error(messages[code]), { reason: code });
}

export const b64 = (bytes) =>
  new Uint8Array(bytes).toBase64({ alphabet: 'base64url', omitPadding: true });
const bytes = (s) => Uint8Array.fromBase64(s, { alphabet: 'base64url' });
const hash = (s) => crypto.subtle.digest('SHA-256', encode.encode(s));

export async function proofBytes(nonce, jwk, jwt) {
  if (typeof nonce !== 'string' || !/^[\w-]{43}$/.test(nonce) || b64(bytes(nonce)) !== nonce)
    throw refusal('E_UNAVAILABLE');
  const prefix = encode.encode(`slicc-cdp-lease-v1:${jwt ? 'data' : 'request'}\0`);
  const transcript = new Uint8Array(prefix.length + 64);
  transcript.set(prefix);
  transcript.set(bytes(nonce), prefix.length);
  const { crv, kty, x } = jwk;
  transcript.set(
    new Uint8Array(await hash(jwt || JSON.stringify({ crv, kty, x }))),
    prefix.length + 32
  );
  return transcript;
}

export async function holderKey() {
  requireLeaseBuild();
  const { privateKey, publicKey } = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ]);
  const { crv, kty, x } = await crypto.subtle.exportKey('jwk', publicKey);
  const jwk = { crv, kty, x };
  const binding = await hash(JSON.stringify(jwk));
  return {
    jwk,
    jkt: b64(binding),
    async proof(nonce, jwt) {
      const transcript = await proofBytes(nonce, jwk, jwt);
      return {
        type: 'proof',
        sig: b64(await crypto.subtle.sign('Ed25519', privateKey, transcript)),
      };
    },
  };
}

export function fields(token) {
  if (
    typeof token !== 'string' ||
    token.length > 16384 ||
    !/^[\w-]+\.[\w-]+\.[\w-]{86}$/.test(token)
  )
    throw refusal('E_UNAVAILABLE');
  const [head, body] = token.split('.').map((s) => bytes(s));
  const { typ, alg, ...other } = JSON.parse(decode.decode(head));
  if (typ !== 'slicc-cdp-lease+jwt' || alg !== 'Ed25519' || Object.keys(other).length)
    throw refusal('E_UNAVAILABLE');
  return JSON.parse(decode.decode(body));
}

export function records(stream) {
  const reader = bufferedReader(stream);
  return {
    async read() {
      const n = new DataView((await reader.take(4)).buffer).getUint32(0);
      if (n < 1 || n > 65536) throw refusal('E_UNAVAILABLE');
      return JSON.parse(decode.decode(await reader.take(n)));
    },
    write(value) {
      const body = encode.encode(JSON.stringify(value));
      if (body.length > 65536) throw refusal('E_UNSUPPORTED');
      const frame = new Uint8Array(4 + body.length);
      new DataView(frame.buffer).setUint32(0, body.length);
      frame.set(body, 4);
      return stream.write(frame);
    },
  };
}

export function expect(record, type, id) {
  if (record?.id !== id) throw refusal('E_UNAVAILABLE');
  if (record?.type === 'error') throw refusal(record.reason);
  if (record?.type !== type) throw refusal('E_UNAVAILABLE');
  return record;
}

export async function openLease(session, key, meta, signal) {
  requireLeaseBuild();
  const timeout = AbortSignal.timeout(30000);
  const opening = AbortSignal.any([signal, timeout]);
  const closeLink = () => session.close('lease open cancelled');
  opening.throwIfAborted();
  opening.addEventListener('abort', closeLink, { once: true });
  let stream;
  try {
    stream = await session.open({ kind: LEASE_KIND, jwk: key.jwk, ...meta });
    const wire = records(stream);
    const proof = await key.proof(stream.info.nonce, meta.jwt);
    opening.throwIfAborted();
    await wire.write(proof);
    return {
      ...wire,
      close: () => stream.close(),
      end: () => stream.closeWrite(),
      settled: stream.settled,
    };
  } catch (error) {
    stream?.close();
    throw error;
  } finally {
    opening.removeEventListener('abort', closeLink);
  }
}
