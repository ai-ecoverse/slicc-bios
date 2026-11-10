import real from './real.mjs';

export const kinds = { ...real.kinds, 'capture.camera': {}, 'capture.devices': {} };

const fail = (name, message) => new DOMException(message, name);
const moving = (options) => options.type === 'video/webm' || options.type === 'video/mp4';

function stopAll(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function constraintsOf(options) {
  if (options.asks !== undefined) return options.asks;
  const track = {};
  if (options.device !== undefined) track.deviceId = { exact: options.device };
  for (const field of ['width', 'height', 'frameRate'])
    if (options[field] !== undefined)
      track[field] = { [options.exact ? 'exact' : 'ideal']: options[field] };
  let audio = false;
  if (moving(options) && options.microphone)
    audio = options.microphone === true ? true : { deviceId: { exact: options.microphone } };
  return { video: Object.keys(track).length > 0 ? track : true, audio };
}

async function still(stream, options, signal) {
  await sleep((options.warmup ?? 1.5) * 1000, signal);
  const [track] = stream.getVideoTracks();
  const bitmap = await new ImageCapture(track).grabFrame();
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: options.type ?? 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function film(stream, options, signal, progress) {
  const audio = stream.getAudioTracks().length > 0;
  const recorder = new MediaRecorder(stream, {
    mimeType: audio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8',
  });
  const [track] = stream.getVideoTracks();
  let done = false;
  let timer = null;
  let queue = Promise.resolve();
  const end = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const finish = () => {
    if (done) return false;
    done = true;
    clearTimeout(timer);
    if (!options.keep) stopAll(stream);
    return true;
  };
  return new ReadableStream({
    start(controller) {
      recorder.ondataavailable = ({ data }) => {
        queue = queue.then(async () => {
          const bytes = new Uint8Array(await data.arrayBuffer());
          if (!done && bytes.length) controller.enqueue(bytes);
        });
      };
      recorder.onstop = () =>
        queue.then(() => {
          if (finish()) controller.close();
        });
      track.addEventListener('ended', end, { once: true });
      signal.addEventListener(
        'abort',
        () => {
          end();
          if (finish()) controller.error(signal.reason);
        },
        { once: true }
      );
      if (options.duration) timer = setTimeout(end, options.duration * 1000);
      recorder.start(250);
      progress('recording…');
    },
    cancel() {
      end();
      finish();
    },
  });
}

async function listed() {
  const found = await navigator.mediaDevices.enumerateDevices();
  const lines = ['videoinput', 'audioinput'].flatMap((kind) =>
    found
      .filter((device) => device.kind === kind)
      .map(
        (device) =>
          `${kind === 'videoinput' ? 'video' : 'audio'}\t${device.deviceId}\t${device.label}\n`
      )
  );
  return new TextEncoder().encode(lines.join(''));
}

export async function handle(request) {
  if (
    request.options?.asks === undefined &&
    request.options?.keep === undefined &&
    Object.hasOwn(real.kinds, request.kind)
  )
    return real.handle(request);
  if (request.kind === 'capture.devices') return listed();
  const { options = {}, signal = new AbortController().signal, progress = () => {} } = request;
  if (typeof request.userMedia !== 'function')
    throw fail('NotSupportedError', 'this page does not record the camera');
  const stream = await request.userMedia(constraintsOf(options));
  if (moving(options)) return film(stream, options, signal, progress);
  try {
    return await still(stream, options, signal);
  } finally {
    if (!options.keep) stopAll(stream);
  }
}

export default { kinds, handle };
