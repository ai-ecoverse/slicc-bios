import { STOPPED } from './requests.js';

export const COMPOSER = Object.freeze({
  tag: JSON.stringify({ kind: 'user', where: 'composer' }),
});
export const RECORDS = Object.freeze(['audio']);
export const ALREADY = 'seven is already recording from the composer';
export const CANCELLED = 'the recording was cancelled';
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

export function composerCapture({ record, still, now = Date.now }) {
  let live = null;
  return {
    kinds: RECORDS,
    async record(kind) {
      if (!RECORDS.includes(kind)) throw new DOMException(unrecorded(kind), 'NotSupportedError');
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
