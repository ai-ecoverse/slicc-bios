import { dial, hubClient } from '/seed/follow.js';
import { records } from '/seed/lease-wire.js';

const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (b) => new Uint8Array(b).toBase64({ alphabet: 'base64url', omitPadding: true });
const packed = (v) => b64(utf8(JSON.stringify(v)));
const digest = (s) => crypto.subtle.digest('SHA-256', utf8(s));

export async function broker() {
  const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
  const issuer = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const fingerprint = cert
    .getFingerprints()
    .find((f) => f.algorithm === 'sha-256')
    .value.replaceAll(':', '')
    .toLowerCase();
  const round = () => ({
    decision: Promise.withResolvers(),
    delivered: Promise.withResolvers(),
    pending: Promise.withResolvers(),
  });
  let approval = round();
  let connected, issued, exp, expected, allowed, pinned, pc;
  const nonces = [],
    actions = [];
  async function accept(meta) {
    const certs = pc.sctp.transport.getRemoteCertificates();
    if (new Uint8Array(await crypto.subtle.digest('SHA-256', certs[0])).toHex() !== pinned)
      throw new Error('Unpaired Seven');
    if (meta.kind !== 'cdp-lease-v1' || !['request', 'data'].includes(meta.mode))
      throw new Error('unsupported');
    const { decision, delivered, pending } = approval;
    return {
      handle: async (s) => {
        const wire = records(s);
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        const { crv, kty, x } = meta.jwk;
        try {
          const key = await crypto.subtle.importKey('jwk', meta.jwk, 'Ed25519', false, ['verify']);
          const jkt = b64(await digest(JSON.stringify({ crv, kty, x })));
          if (jkt !== expected || (meta.mode === 'data' && (!issued || meta.jwt !== issued)))
            throw new Error('binding');
          s.accepted({ nonce: b64(nonce) });
          const proof = await wire.read();
          const data = new Uint8Array(
            await new Blob([
              utf8(`slicc-cdp-lease-v1:${meta.mode}\0`),
              nonce,
              await digest(meta.mode === 'data' ? meta.jwt : JSON.stringify({ crv, kty, x })),
            ]).arrayBuffer()
          );
          if (
            proof.type !== 'proof' ||
            !(await crypto.subtle.verify(
              'Ed25519',
              key,
              Uint8Array.fromBase64(proof.sig, { alphabet: 'base64url' }),
              data
            ))
          )
            throw new Error('proof');
          nonces.push({ mode: meta.mode, nonce: b64(nonce) });
          if (meta.mode === 'request') {
            await wire.write({ type: 'pending', request: 'R1' });
            pending.resolve();
            await decision.promise;
            allowed = meta.allow[0].url;
            const claims = {
              iss: 'urn:fixture:broker',
              aud: 'urn:fixture:cdp-lease',
              jti: crypto.randomUUID(),
              exp,
              cnf: { jkt },
              browser_session: 'disposable',
              allow: meta.allow,
            };
            const input = `${packed({ typ: 'slicc-cdp-lease+jwt', alg: 'Ed25519' })}.${packed(claims)}`;
            issued = `${input}.${b64(await crypto.subtle.sign('Ed25519', issuer.privateKey, utf8(input)))}`;
            await wire.write({ type: 'grant', request: 'R1', jwt: issued });
            s.closeWrite();
            delivered.resolve(s.settled);
            return;
          }
          await wire.write({ type: 'ready' });
          for (;;) {
            const { id, op, args } = await wire.read();
            const valid =
              (op === 'goto' && new URL(args.url).origin === allowed) || op === 'snapshot';
            actions.push(op);
            await wire.write(
              !valid
                ? {
                    type: 'error',
                    id,
                    reason: 'E_SCOPE',
                    message: 'untrusted redirect detail not for job',
                  }
                : { type: 'result', id, result: op === 'snapshot' ? { text: 'Invoice 1042' } : {} }
            );
          }
        } catch {
          s.reset('E_REVOKED');
        }
      },
    };
  }
  return {
    fingerprint,
    nonces,
    actions,
    get pending() {
      return approval.pending.promise;
    },
    approve(until) {
      exp = until;
      approval.decision.resolve();
      return approval.delivered.promise.then(() => undefined);
    },
    async connect(url, jkt, leader, caps = ['cdp-lease-v1']) {
      expected = jkt;
      pinned = leader;
      const controllerId = crypto.randomUUID();
      const { linked } = await dial(
        {
          runtime: 'slicc-link/1',
          hub: new URL(url).origin,
          url: () => url,
          post: hubClient({ fetch }),
          hello: () => ({ name: 'fixture', caps }),
          accept,
          makePeer: (o) => {
            pc = new RTCPeerConnection(o);
            return pc;
          },
          cert: () => cert,
          adopt() {},
          timers: globalThis,
          over: () => false,
          waiting() {},
          now: Date.now,
          nap: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
        controllerId
      );
      connected = await linked;
      return connected.caps();
    },
    async raw(kind) {
      await connected.open({ kind });
    },
    disconnect() {
      connected?.close('fixture reconnect');
      issued = undefined;
      approval = round();
    },
  };
}
