import { STOPPED } from './requests.js';

export const COMPOSER = Object.freeze({
  tag: JSON.stringify({ kind: 'user', where: 'composer' }),
});
export const RECORDS = Object.freeze(['audio']);
export const ALREADY = 'seven is already recording from the composer';
export const CANCELLED = 'the recording was cancelled';
export const EMPTY = 'nothing was recorded';
export const UNCLICKED = 'the composer captures only inside a click';
export const unrecorded = (kind) => `seven doesn't record ${kind} from the composer`;

export const stamped = (time) => new Date(time).toISOString().slice(0, 19).replace(/:/g, '-');

const asked = (kind, options, signal) => ({
  kind,
  options,
  body: null,
  stamp: COMPOSER,
  signal,
  progress() {},
});

const clicked = () => globalThis.navigator?.userActivation?.isActive === true;

export function composerCapture({ record, still, now = Date.now, active = clicked }) {
  let live = null;
  const unclicked = () => {
    if (!active()) throw new DOMException(UNCLICKED, 'NotAllowedError');
  };
  return {
    kinds: RECORDS,
    async record(kind) {
      if (!RECORDS.includes(kind)) throw new DOMException(unrecorded(kind), 'NotSupportedError');
      unclicked();
      if (live) throw new DOMException(ALREADY, 'InvalidStateError');
      const controller = new AbortController();
      live = controller;
      let run;
      try {
        run = await record(asked('audio.record', { gate: false }, controller.signal));
      } catch (error) {
        live = null;
        throw error;
      }
      const started = now();
      let cancelled = false;
      const finished = new Response(run.reply, { headers: { 'content-type': 'audio/webm' } })
        .blob()
        .finally(() => {
          live = null;
        })
        .then((blob) => {
          if (cancelled) throw new DOMException(CANCELLED, 'AbortError');
          run.check();
          if (!blob.size) throw new DOMException(EMPTY, 'AbortError');
          return {
            blob,
            mimeType: 'audio/webm',
            name: `recording-${stamped(started)}.webm`,
            durationMs: Math.max(0, now() - started),
          };
        });
      return {
        stop: () => controller.abort(new DOMException(STOPPED, 'AbortError')),
        cancel: () => {
          cancelled = true;
          controller.abort(new DOMException(CANCELLED, 'AbortError'));
        },
        finished,
      };
    },
    async still() {
      unclicked();
      const taken = now();
      const run = await still(
        asked('capture.screen', { type: 'image/png' }, new AbortController().signal)
      );
      return {
        blob: new Blob([run.reply], { type: 'image/png' }),
        mimeType: 'image/png',
        name: `screenshot-${stamped(taken)}.png`,
      };
    },
  };
}
