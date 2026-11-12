export const COMPOSER = Object.freeze({
  tag: JSON.stringify({ kind: 'user', where: 'composer' }),
});
export const RECORDS = Object.freeze(['audio', 'video']);
const TAKES = {
  audio: {
    kind: 'audio.record',
    options: { gate: false },
    mimeType: 'audio/webm',
    name: 'recording',
  },
  video: {
    kind: 'capture.camera',
    options: { type: 'video/webm', microphone: true },
    mimeType: 'video/webm',
    name: 'video',
  },
};
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

export function composerCapture({ audio, video, still, now = Date.now, active = clicked }) {
  const records = { audio, video };
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
      const take = TAKES[kind];
      const controller = new AbortController();
      live = controller;
      let run;
      try {
        run = await records[kind](asked(take.kind, take.options, controller.signal));
      } catch (error) {
        live = null;
        throw error;
      }
      const started = now();
      let cancelled = false;
      const finished = new Response(run.reply, { headers: { 'content-type': take.mimeType } })
        .blob()
        .finally(() => {
          live = null;
        })
        .then(
          (blob) => blob,
          (error) => {
            if (cancelled) throw new DOMException(CANCELLED, 'AbortError');
            run.check();
            throw error;
          }
        )
        .then((blob) => {
          if (cancelled) throw new DOMException(CANCELLED, 'AbortError');
          run.check();
          if (!blob.size) {
            run.cut();
            throw new DOMException(EMPTY, 'AbortError');
          }
          return {
            blob,
            mimeType: take.mimeType,
            name: `${take.name}-${stamped(started)}.webm`,
            durationMs: Math.max(0, now() - started),
          };
        });
      return {
        stop: () => run.stop(),
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
