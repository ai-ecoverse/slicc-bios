import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const faux = () => {
  globalThis.sliccKernelDebug = true;
  window.asked = [];
  globalThis.sliccCaptureAgent = {
    approveCapture: async (request) => {
      window.asked.push(request.kind);
      return 'deny';
    },
  };
  window.deep = (selector, root = document) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && window.deep(selector, element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  window.composer = () => {
    const dock = document.querySelector('slicc-app').dock;
    const ids = dock.api.panels.map((panel) => panel.id);
    const chats = [
      ...ids.filter((id) => id.startsWith('chat:')),
      ...ids.filter((id) => id === 'chat'),
    ];
    const view = chats.map((id) => dock.content(id)).find((each) => each?.shadowRoot);
    return view ? window.deep('slicc-composer', view.shadowRoot) : null;
  };
  window.chips = () =>
    [...(window.deep('[data-surface="live"]')?.querySelectorAll('[data-id]') ?? [])].map((chip) =>
      chip.textContent.replace(/\s+/g, ' ').trim()
    );
  window.clickItems = () =>
    document
      .querySelector('slicc-app')
      ?.model?.approvals?.list()
      .filter((item) => item.kind === 'click') ?? [];
  window.prompted = 0;
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...args) {
    if (this.getRootNode()?.host?.localName === 'slicc-confirm') window.prompted += 1;
    return showModal.apply(this, args);
  };
  window.failed = (error) => ({ name: error?.name, message: error?.message });
  window.head = (blob) =>
    blob
      .slice(0, 4)
      .arrayBuffer()
      .then((buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16)).join(' '));
  window.capture = () => document.querySelector('slicc-app').model.capture;
  window.switchTo = (key, on) => document.querySelector('slicc-app').model.switches.set(key, on);
  window.mics = [];
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints) => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      window.mics.push({
        constraints,
        active: navigator.userActivation.isActive,
        tracks: out.stream.getTracks(),
      });
      return out.stream;
    },
  });
  window.micsLive = () =>
    window.mics.flatMap((mic) => mic.tracks).filter((track) => track.readyState === 'live').length;
  window.displays = [];
  window.handle = { handle: 'ordinary', origin: 'https://example.test' };
  window.hold = null;
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async (constraints) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      context.fillStyle = '#0a6';
      context.fillRect(0, 0, 32, 32);
      const stream = canvas.captureStream(10);
      const [track] = stream.getVideoTracks();
      const handle = window.handle;
      track.getCaptureHandle = () => handle;
      window.displays.push({ constraints, active: navigator.userActivation.isActive, track });
      if (window.hold) await window.hold;
      return stream;
    },
  });
};

async function seven(t) {
  const page = await chrome.page(t);
  await page.init(faux);
  await boot(page);
  return page;
}

async function press(page, selector, inner) {
  await page.until(
    (selector, inner) => {
      const host = window.deep(selector);
      const target = inner ? window.deep(inner, host?.shadowRoot ?? document) : host;
      const box = target?.getBoundingClientRect();
      return !!box && box.width > 0 && !target.disabled;
    },
    selector,
    inner
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const { x, y } = await page.evaluate(
    (selector, inner) => {
      const host = window.deep(selector);
      const target = inner ? window.deep(inner, host.shadowRoot ?? document) : host;
      const box = target.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    },
    selector,
    inner
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

test('the composer’s Record audio records inside the click with no consent and no click item, and the chip’s Stop attaches the recording', async (t) => {
  const page = await seven(t);
  assert.deepEqual(await page.evaluate(() => window.capture().kinds), ['audio']);
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => !!window.composer()?.shadowRoot);
  await page.evaluate(() => {
    window.inComposer = (selector) => window.deep(selector, window.composer().shadowRoot);
  });
  await page.until(() => !!window.inComposer('swc-prompt-field')?.shadowRoot);
  const { x, y } = await page.evaluate(() => {
    const box = window
      .inComposer('swc-prompt-field')
      .shadowRoot.querySelector('.swc-PromptField-upload')
      .getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await page.until(() => {
    const item = window.inComposer('[data-action="record-audio"]');
    const box = item?.getBoundingClientRect();
    return !!box && box.width > 0;
  });
  assert.equal(
    await page.evaluate(() => !!window.inComposer('[data-action="record-video"]')),
    false
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const item = await page.evaluate(() => {
    const box = window.inComposer('[data-action="record-audio"]').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: item.x,
      y: item.y,
      button: 'left',
      clickCount: 1,
    });
  await page.until(() => window.chips().some((chip) => chip.startsWith('Recording microphone')));
  assert.match(
    (await page.evaluate(() => window.chips()))[0],
    /^Recording microphone · you · \d+:\d\d/
  );
  const [mic] = await page.evaluate(() =>
    window.mics.map(({ constraints, active }) => ({ constraints, active }))
  );
  assert.deepEqual(mic, { constraints: { audio: true }, active: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await press(page, '[data-surface="live"] [data-action="live-act"]');
  await page.until(() =>
    [
      ...window.composer().shadowRoot.querySelectorAll('swc-upload-attachment:not([data-error])'),
    ].some((each) => /recording-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.webm/.test(each.textContent))
  );
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.micsLive() === 0);
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('record: stop() finishes a WebM take and releases the microphone, cancel discards, a second record is refused, and the Microphone switch refuses and cuts', async (t) => {
  const page = await seven(t);
  const take = await page.evaluate(async () => {
    const recording = await window.capture().record('audio');
    const second = await window
      .capture()
      .record('audio')
      .then(
        () => null,
        (error) => window.failed(error)
      );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const chips = window.chips();
    recording.stop();
    const { blob, mimeType, name, durationMs } = await recording.finished;
    return {
      second,
      chips,
      mimeType,
      name,
      durationMs,
      type: blob.type,
      size: blob.size,
      head: await window.head(blob),
    };
  });
  assert.deepEqual(take.second, {
    name: 'InvalidStateError',
    message: 'seven is already recording from the composer',
  });
  assert.match(take.chips[0], /^Recording microphone · you/);
  assert.equal(take.mimeType, 'audio/webm');
  assert.equal(take.type, 'audio/webm');
  assert.match(take.name, /^recording-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.webm$/);
  assert.ok(take.durationMs >= 1000, String(take.durationMs));
  assert.ok(take.size > 0);
  assert.equal(take.head, '1a 45 df a3');
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.micsLive() === 0);

  const cancelled = await page.evaluate(async () => {
    const recording = await window.capture().record('audio');
    await new Promise((resolve) => setTimeout(resolve, 500));
    recording.cancel();
    return recording.finished.then(
      () => null,
      (error) => window.failed(error)
    );
  });
  assert.deepEqual(cancelled, { name: 'AbortError', message: 'the recording was cancelled' });
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.micsLive() === 0);

  const cut = await page.evaluate(async () => {
    const recording = await window.capture().record('audio');
    await new Promise((resolve) => setTimeout(resolve, 500));
    window.switchTo('microphone', false);
    return recording.finished.then(
      () => null,
      (error) => window.failed(error)
    );
  });
  assert.deepEqual(cut, {
    name: 'NotAllowedError',
    message: "microphone capture is off in seven's settings",
  });
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.micsLive() === 0);
  const before = await page.evaluate(() => window.mics.length);
  const refused = await page.evaluate(() =>
    window
      .capture()
      .record('audio')
      .then(
        () => null,
        (error) => window.failed(error)
      )
  );
  assert.deepEqual(refused, {
    name: 'NotAllowedError',
    message: "microphone capture is off in seven's settings",
  });
  assert.equal(await page.evaluate(() => window.mics.length), before);
  const video = await page.evaluate(() =>
    window
      .capture()
      .record('video')
      .then(
        () => null,
        (error) => window.failed(error)
      )
  );
  assert.equal(video.name, 'NotSupportedError');
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('still: the picker runs through the screen guards with a Taking a photo chip, seven’s own page is refused, and the Screen switch refuses before the picker', async (t) => {
  const page = await seven(t);
  const shot = await page.evaluate(async () => {
    let release;
    window.hold = new Promise((resolve) => {
      release = resolve;
    });
    const pending = window.capture().still();
    while (!window.chips().length) await new Promise((resolve) => setTimeout(resolve, 50));
    const chips = window.chips();
    window.hold = null;
    release();
    const { blob, mimeType, name } = await pending;
    const [display] = window.displays;
    return {
      chips,
      mimeType,
      name,
      type: blob.type,
      head: await window.head(blob),
      constraints: display.constraints,
      ended: display.track.readyState,
    };
  });
  assert.match(shot.chips[0], /^Taking a photo · you/);
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.type, 'image/png');
  assert.match(shot.name, /^screenshot-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.png$/);
  assert.equal(shot.head, '89 50 4e 47');
  assert.equal(shot.constraints.selfBrowserSurface, 'exclude');
  assert.equal(shot.constraints.surfaceSwitching, 'exclude');
  assert.equal(shot.constraints.preferCurrentTab, false);
  assert.equal(shot.constraints.audio, false);
  assert.equal(shot.ended, 'ended');
  await page.until(() => window.chips().length === 0);

  const own = await page.evaluate(async () => {
    window.handle = { handle: 'slicc-seven', origin: location.origin };
    const error = await window
      .capture()
      .still()
      .then(
        () => null,
        (error) => window.failed(error)
      );
    window.handle = { handle: 'ordinary', origin: 'https://example.test' };
    return { error, ended: window.displays.at(-1).track.readyState };
  });
  assert.deepEqual(own, {
    error: { name: 'NotAllowedError', message: "seven doesn't capture its own pages or the vault" },
    ended: 'ended',
  });
  await page.until(() => window.chips().length === 0);

  const cut = await page.evaluate(async () => {
    let release;
    window.hold = new Promise((resolve) => {
      release = resolve;
    });
    const pending = window
      .capture()
      .still()
      .then(
        () => null,
        (error) => window.failed(error)
      );
    while (!window.chips().length) await new Promise((resolve) => setTimeout(resolve, 50));
    window.switchTo('screen', false);
    window.hold = null;
    release();
    return pending;
  });
  assert.deepEqual(cut, {
    name: 'NotAllowedError',
    message: "screen capture is off in seven's settings",
  });
  await page.until(() => window.chips().length === 0);
  const before = await page.evaluate(() => window.displays.length);
  const refused = await page.evaluate(() =>
    window
      .capture()
      .still()
      .then(
        () => null,
        (error) => window.failed(error)
      )
  );
  assert.deepEqual(refused, {
    name: 'NotAllowedError',
    message: "screen capture is off in seven's settings",
  });
  assert.equal(await page.evaluate(() => window.displays.length), before);
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});
