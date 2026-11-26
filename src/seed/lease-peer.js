import { LEASE_PRODUCT_VERSION } from './lease-build.js';
import { offerLink } from './link.js';

export const LEASE_KIND = 'cdp-lease-v1';

export function requireLeaseBuild() {
  if (LEASE_PRODUCT_VERSION !== 1)
    throw Object.assign(new Error('Browser leases are disabled in this build.'), {
      reason: 'E_UNSUPPORTED',
    });
}

function pinnedAnswer(sdp, pin) {
  const prints = typeof sdp === 'string' && sdp.match(/^a=fingerprint:.*$/gim);
  return (
    prints?.length &&
    prints.every((line) => {
      const match = /^a=fingerprint:sha-256 ((?:[\da-f]{2}:){31}[\da-f]{2})$/i.exec(line.trimEnd());
      return match && match[1].replaceAll(':', '').toLowerCase() === pin;
    })
  );
}

async function authenticated(pc, pin) {
  const cert = pc.sctp?.transport?.getRemoteCertificates?.()[0];
  if (!cert) return false;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', cert)).toHex() === pin;
}

export function leaseFollowers({
  job,
  broker,
  certificate,
  makePeer,
  timers,
  refuse,
  relay,
  runtime,
}) {
  requireLeaseBuild();
  if (!/^[a-f0-9]{64}$/.test(broker) || !certificate) throw new Error('Pair the broker first.');
  let pending;
  let live;
  const drop = (item) => item?.offer.session.close('lease link closed');
  const matches = (m) =>
    pending && pending.controllerId === m.controllerId && pending.bootstrapId === m.bootstrapId;
  return {
    join(m) {
      if (m.runtime !== runtime || m.trust !== 'full' || m.biscotto) {
        refuse(m, 'UNTRUSTED', 'This tray accepts only a paired lease broker.');
        return;
      }
      drop(pending);
      const item = { controllerId: m.controllerId, bootstrapId: m.bootstrapId };
      const pc = makePeer({ iceServers: m.iceServers ?? [], certificates: [certificate] });
      item.offer = offerLink({
        pc,
        timers,
        send: relay(m.controllerId, m.bootstrapId),
        hello: () => ({ name: 'Seven lease job', caps: [LEASE_KIND] }),
        onClose: () => {
          if (pending === item) pending = undefined;
          if (live === item) {
            live = undefined;
            job.detach(item.offer.session);
          }
        },
      });
      pending = item;
      const { session } = item.offer;
      item.offer.started.catch(() => drop(item));
      session.ready
        .then(async (peer) => {
          if (
            peer.v !== 1 ||
            peer.caps?.length !== 1 ||
            peer.caps[0] !== LEASE_KIND ||
            !item.answered ||
            !(await authenticated(pc, broker)) ||
            pending !== item
          ) {
            drop(item);
            return;
          }
          drop(live);
          pending = undefined;
          live = item;
          job.attach(session);
        })
        .catch(() => drop(item));
    },
    answer(m) {
      if (!matches(m)) return;
      const item = pending;
      if (item.answered || !pinnedAnswer(m.answer?.sdp, broker)) {
        refuse(m, 'UNTRUSTED', 'The broker identity does not match the paired device.');
        drop(item);
        return;
      }
      item.answered = true;
      item.offer.receive({ t: 'answer', sdp: m.answer.sdp }).catch(() => drop(item));
    },
    candidate(m) {
      const item = [pending, live].find(
        (i) => i && i.controllerId === m.controllerId && i.bootstrapId === m.bootstrapId
      );
      item?.offer.receive({ t: 'candidate', candidate: m.candidate }).catch(() => drop(item));
    },
    close() {
      drop(pending);
      drop(live);
    },
  };
}
