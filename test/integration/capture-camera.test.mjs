import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { standIn } from './camera-standin.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch({ tools: false, intercept: [] });
after(() => chrome.close());
const camera = await standIn(chrome);

const faux = () => {
  globalThis.sliccKernelDebug = true;
  window.faux = { answer: 'once', seen: [] };
  globalThis.sliccCaptureAgent = {
    approveCapture: async (request) => {
      window.faux.seen.push({
        kind: request.kind,
        options: request.options,
        label: request.label ?? null,
      });
      const { answer } = window.faux;
      if (answer === 'EAGAIN')
        throw Object.assign(new Error('the agent is restarting'), { code: 'EAGAIN' });
      return answer;
    },
  };
  window.deep = (selector) => {
    const walk = (root) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(document);
  };
  window.clickItems = () =>
    document
      .querySelector('slicc-app')
      ?.model?.approvals?.list()
      .filter((item) => item.kind === 'click') ?? [];
  window.chips = () =>
    [...(window.deep('[data-surface="live"]')?.querySelectorAll('[data-id]') ?? [])].map((chip) =>
      chip.textContent.replace(/\s+/g, ' ').trim()
    );
  window.prompted = 0;
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...args) {
    if (this.getRootNode()?.host?.localName === 'slicc-confirm') window.prompted += 1;
    return showModal.apply(this, args);
  };
  window.states = { camera: 'granted', microphone: 'granted' };
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor) =>
    Object.hasOwn(window.states, descriptor?.name)
      ? Promise.resolve({ state: window.states[descriptor.name] })
      : query(descriptor);
  Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
    configurable: true,
    value: async () => [
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Fake Camera', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Fake Microphone', groupId: 'g' },
    ],
  });
  window.chunks = 0;
  const Recorder = MediaRecorder;
  globalThis.MediaRecorder = class extends Recorder {
    constructor(...args) {
      super(...args);
      this.addEventListener('dataavailable', ({ data }) => {
        if (data.size) window.chunks += 1;
      });
    }
  };
  window.opened = [];
  window.running = 0;
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints) => {
      window.opened.push({ constraints, active: navigator.userActivation.isActive });
      const tracks = [];
      if (constraints?.video) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d');
        const paint = () => {
          context.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`;
          context.fillRect(0, 0, 64, 64);
        };
        paint();
        const timer = setInterval(paint, 50);
        const [track] = canvas.captureStream(10).getVideoTracks();
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(timer);
          stop();
        };
        tracks.push(track);
      }
      if (constraints?.audio) {
        const context = new AudioContext();
        const tone = context.createOscillator();
        const out = context.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        tracks.push(...out.stream.getAudioTracks());
      }
      for (const track of tracks) {
        window.running += 1;
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => {
          if (!stopped) window.running -= 1;
          stopped = true;
          stop();
        };
      }
      return new MediaStream(tracks);
    },
  });
};

async function seven(t) {
  const page = await chrome.page(t);
  camera();
  await page.init(faux);
  await boot(page);
  return page;
}

const answer = (page, value) =>
  page.evaluate((value) => {
    window.faux.answer = value;
  }, value);

const states = (page, value) =>
  page.evaluate((value) => Object.assign(window.states, value), value);

const turn = (page, key, on) =>
  page.evaluate(
    ([key, on]) => document.querySelector('slicc-app').model.switches.set(key, on),
    [key, on]
  );

const ask = (header, file, name) =>
  `exec 3<>/dev/embedder; printf '%s\\n' '${JSON.stringify({ kind: 'capture.camera', ...header })}' >&3; cat <&3 > ${file}; echo "${name} $?"; exec 3<&-`;

const plain = (header, name) =>
  `printf '%s\\n' '${JSON.stringify({ kind: 'capture.camera', ...header })}' | cat > /dev/embedder; echo "${name} $?"`;

const shaped = (header, name) =>
  `printf '%s\\n' '${JSON.stringify({ kind: 'capture.camera', ...header })}' | cat > /dev/embedder 2> /tmp/${name}.err; echo "${name} $?"; grep -q 'answer this camera request' /tmp/${name}.err && echo "${name} refused"`;

async function pressDeep(page, selector) {
  await page.until((selector) => {
    const box = window.deep(selector)?.getBoundingClientRect();
    if (!box || box.width <= 0) return false;
    const key = [selector, box.x, box.y, box.width, box.height].join();
    window.settled =
      window.settled?.key === key ? { key, polls: window.settled.polls + 1 } : { key, polls: 1 };
    return window.settled.polls >= 4;
  }, selector);
  const { x, y } = await page.evaluate((selector) => {
    const box = window.deep(selector).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, selector);
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

async function pressConfirm(page, which) {
  await page.until((which) => {
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-confirm') return element;
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    window.confirmed = walk(document);
    return !!window.confirmed?.shadowRoot?.querySelector(`[data-${which}]`);
  }, which);
  const { x, y } = await page.evaluate((which) => {
    const box = window.confirmed.shadowRoot
      .querySelector(`[data-${which}]`)
      .getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, which);
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const recorded = async (page) => {
  const before = await page.evaluate(() => window.chunks);
  await page.until((before) => window.chunks > before, before);
};

const CLICK = 'dialog[data-kind="click"]';
const STOP = '[data-surface="live"] [data-action="live-act"]';

test('a typed camera still opens the named camera at once, a background one asks Allow camera only while the browser would prompt, and its click opens the camera', async (t) => {
  const page = await seven(t);
  await states(page, { camera: 'prompt' });
  await run(
    page,
    `${ask({ type: 'image/png', device: 'cam-1', warmup: 0 }, '/tmp/typed.png', 'typed')}; head -c 4 /tmp/typed.png | tail -c 3; echo`
  );
  await shows(page, 'typed 0');
  await shows(page, 'PNG');
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  const [seen] = await page.evaluate(() => window.faux.seen);
  assert.equal(seen.kind, 'capture.camera');
  assert.equal(seen.label, 'Fake Camera');
  const [typed] = await page.evaluate(() => window.opened);
  assert.deepEqual(typed.constraints.video, { deviceId: { exact: 'cam-1' } });
  assert.equal(typed.constraints.audio ?? false, false);

  await run(page, `sleep 8; ${ask({ type: 'image/jpeg', warmup: 0 }, '/tmp/asked.jpg', 'asked')}`);
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.subject, 'capture');
  assert.equal(item.what, 'camera');
  assert.equal(item.action, 'Allow camera');
  assert.equal(item.title, 'Allow the camera?');
  assert.match(
    item.body,
    /^A program asks seven to take a photo with your camera\. The browser asks next whether seven may use it\.$/
  );
  await shows(page, "waiting for a click in seven's tab: allow the camera");
  assert.equal(await page.evaluate(() => window.opened.length), 1);
  await shoot(page, 'camera-click-item');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await shows(page, 'asked 0');
  assert.equal(await page.evaluate(() => window.opened.at(-1).active), true);

  await states(page, { camera: 'granted' });
  await run(
    page,
    `sleep 8; ${ask({ type: 'image/png', warmup: 0 }, '/tmp/granted.png', 'granted')}`
  );
  await shows(page, 'granted 0');
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.opened.length), 3);
  await page.until(() => window.running === 0);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a camera recording with the microphone asks one click for both, opens them in one call, shows its chip, and Stop leaves a finished file', async (t) => {
  const page = await seven(t);
  await states(page, { microphone: 'prompt' });
  await run(
    page,
    `sleep 8; ${ask({ type: 'video/webm', microphone: true, duration: 60 }, '/tmp/both.webm', 'both')}; test -s /tmp/both.webm && echo "both file kept"`
  );
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.action, 'Allow camera and microphone');
  assert.equal(item.title, 'Allow the camera and microphone?');
  assert.match(
    item.body,
    /record from your camera and microphone for up to 60 seconds\. The browser asks next whether seven may use them\.$/
  );
  await shows(page, "waiting for a click in seven's tab: allow the camera and microphone");
  await shoot(page, 'camera-click-both');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await page.until(() => window.chips().length === 1);
  assert.match(
    (await page.evaluate(() => window.chips()))[0],
    /^Recording camera · with microphone · a terminal · \d+:\d\d/
  );
  const opened = await page.evaluate(() => window.opened);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].constraints, { video: true, audio: true });
  assert.equal(opened[0].active, true);
  await recorded(page);
  await shoot(page, 'camera-live-chip');
  await page.evaluate((selector) => window.deep(selector).click(), STOP);
  await shows(page, 'both 0', 60000);
  await shows(page, 'both file kept');
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.running === 0);

  await run(page, ask({ type: 'image/png', warmup: 60 }, '/tmp/still.png', 'still'));
  await page.until(() => window.chips().length === 1);
  assert.match((await page.evaluate(() => window.chips()))[0], /^Taking a photo · a terminal/);
  await page.evaluate((selector) => window.deep(selector).click(), STOP);
  await shows(page, 'stopped in seven');
  await shows(page, 'still 1');
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.running === 0);
  assert.deepEqual(page.errors, []);
});

test('the Camera and Microphone switches refuse before the agent and end a live camera recording, while listing devices still answers with no chip', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => {
    window.items = 0;
    document.querySelector('slicc-app').model.live.on('items', (list) => {
      window.items = Math.max(window.items, list.length);
    });
  });
  await turn(page, 'camera', false);
  await turn(page, 'microphone', false);
  await run(
    page,
    `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"capture.devices"}' >&3; cat <&3; echo "listed $?"; exec 3<&-`
  );
  await shows(page, 'listed 0');
  const listed = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.match(listed, /video\s+cam-1\s+Fake Camera/);
  assert.match(listed, /audio\s+mic-1\s+Fake Microphone/);
  await run(
    page,
    `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"audio.record","devices":true}' >&3; cat <&3; echo "mics $?"; exec 3<&-`
  );
  await shows(page, 'mics 0');
  assert.deepEqual(await page.evaluate(() => window.faux.seen), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.equal(await page.evaluate(() => window.items), 0);

  await run(page, plain({ type: 'image/png' }, 'camera off'));
  await shows(page, "camera capture is off in seven's settings");
  await shows(page, 'camera off 1');
  await turn(page, 'camera', true);
  await run(page, plain({ type: 'video/webm', microphone: true, duration: 1 }, 'half off'));
  await shows(page, "microphone capture is off in seven's settings");
  await shows(page, 'half off 1');
  assert.deepEqual(await page.evaluate(() => window.faux.seen), []);
  assert.deepEqual(await page.evaluate(() => window.opened), []);

  await turn(page, 'microphone', true);
  await run(
    page,
    ask({ type: 'video/webm', microphone: true, duration: 60 }, '/tmp/cut.webm', 'cut')
  );
  await page.until(() => window.chips().length === 1 && window.running === 2);
  await recorded(page);
  await turn(page, 'microphone', false);
  await shows(page, 'cut 0', 60000);
  await page.until(() => window.chips().length === 0 && window.running === 0);

  await run(page, ask({ type: 'video/webm', duration: 60 }, '/tmp/cut2.webm', 'cut2'));
  await page.until(() => window.chips().length === 1 && window.running === 1);
  await recorded(page);
  await turn(page, 'camera', false);
  await shows(page, 'cut2 0', 60000);
  await page.until(() => window.chips().length === 0 && window.running === 0);
  await turn(page, 'camera', true);
  await turn(page, 'microphone', true);
  assert.deepEqual(page.errors, []);
});

test('a deny with a message, a blocked camera, EAGAIN’s own prompt, and camera requests of another shape are all refused without opening the camera', async (t) => {
  const page = await seven(t);
  await answer(page, { answer: 'deny', message: 'capture: denied by the approval judge: not now' });
  await run(page, plain({ type: 'image/png' }, 'denied'));
  await shows(page, 'capture: denied by the approval judge: not now');
  await shows(page, 'denied 1');

  await answer(page, 'once');
  await states(page, { camera: 'denied' });
  await run(page, plain({ type: 'image/png' }, 'blocked'));
  await shows(page, 'camera permission is blocked for this site');
  await shows(page, 'blocked 1');
  await states(page, { camera: 'granted' });

  await answer(page, 'EAGAIN');
  await run(page, `sleep 8; ${plain({ type: 'image/png' }, 'fallback')}`);
  await page.until(() => {
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-confirm') return element;
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return /take a photo with your camera/.test(walk(document)?.shadowRoot?.textContent ?? '');
  });
  await pressConfirm(page, 'cancel');
  await shows(page, 'the request to use the camera was dismissed');
  await shows(page, 'fallback 1');
  assert.equal(await page.evaluate(() => window.prompted), 1);

  await answer(page, 'once');
  const seen = await page.evaluate(() => window.faux.seen.length);
  await run(page, shaped({ type: 'image/png', device: 'cam 1' }, 'device'));
  await shows(page, 'device 1');
  await shows(page, 'device refused');
  assert.equal(await page.evaluate(() => window.faux.seen.length), seen);
  for (const [name, header] of [
    ['facing', { type: 'image/png', asks: { video: { facingMode: 'user' } } }],
    ['sound', { type: 'image/png', asks: { video: true, audio: true } }],
    [
      'other',
      { type: 'image/png', device: 'cam-1', asks: { video: { deviceId: { exact: 'cam-2' } } } },
    ],
    ['loose', { type: 'image/png', device: 'cam-1', asks: { video: { deviceId: 'cam-1' } } }],
    ['screen', { type: 'image/png', asks: { video: { displaySurface: 'monitor' } } }],
    ['extra', { type: 'image/png', asks: { video: true, peerIdentity: 'x' } }],
  ]) {
    await run(page, shaped(header, name));
    await shows(page, `${name} 1`);
    await shows(page, `${name} refused`);
  }
  assert.deepEqual(await page.evaluate(() => window.opened), []);
  assert.deepEqual(page.errors, []);
});
