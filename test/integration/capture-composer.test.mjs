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
  window.items = () => document.querySelector('slicc-app').model.live.items();
  window.shown = () =>
    [...(window.deep('[data-surface="live"]')?.querySelectorAll('[data-id]') ?? [])].map(
      (chip) => ({
        text: chip.textContent.replace(/\s+/g, ' ').trim(),
        ended: chip.hasAttribute('data-ended'),
        action: chip.querySelector('[data-action="live-act"]')?.textContent.trim(),
      })
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
  window.switchedOn = (key) =>
    document
      .querySelector('slicc-app')
      .model.switches.list()
      .find((each) => each.key === key)?.on === true;
  window.mics = [];
  window.micCalls = 0;
  window.micHold = null;
  window.silent = false;
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints) => {
      window.micCalls += 1;
      const active = navigator.userActivation.isActive;
      if (window.micHold) await window.micHold;
      const context = new AudioContext();
      if (window.silent) await context.suspend();
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      const tracks = out.stream.getTracks();
      if (constraints?.video) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const paint = canvas.getContext('2d');
        const timer = setInterval(() => {
          paint.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`;
          paint.fillRect(0, 0, 32, 32);
        }, 50);
        const [track] = canvas.captureStream(10).getVideoTracks();
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(timer);
          stop();
        };
        tracks.unshift(track);
      }
      window.mics.push({ constraints, active, tracks, context });
      return constraints?.video ? new MediaStream(tracks) : out.stream;
    },
  });
  window.sounding = () => window.mics.at(-1)?.context.state;
  window.recorders = [];
  const Recorder = MediaRecorder;
  window.MediaRecorder = class extends Recorder {
    constructor(...args) {
      super(...args);
      const seen = { recorder: this, chunks: 0 };
      window.recorders.push(seen);
      this.addEventListener('dataavailable', (event) => {
        if (event.data?.size) seen.chunks += 1;
      });
    }
  };
  window.take = (index) => ({
    chunks: window.recorders[index]?.chunks ?? 0,
    recorder: window.recorders[index]?.recorder.state ?? 'none',
    context: window.sounding() ?? 'none',
  });
  window.inComposer = (selector) => window.deep(selector, window.composer().shadowRoot);
  window.targets = {
    terminal: () => {
      const { dock } = document.querySelector('slicc-app');
      const id = dock.api.panels.map((panel) => panel.id).find((id) => id.startsWith('terminal:'));
      return id ? dock.content(id) : null;
    },
    add: () =>
      window.inComposer('swc-prompt-field')?.shadowRoot?.querySelector('.swc-PromptField-upload'),
    'record-audio': () =>
      window.inComposer('swc-popover')?.open
        ? window.inComposer('[data-action="record-audio"]')
        : null,
    'record-video': () =>
      window.inComposer('swc-popover')?.open
        ? window.inComposer('[data-action="record-video"]')
        : null,
    stop: () => window.deep('[data-surface="live"] [data-action="live-act"]'),
    probe: () => document.getElementById('probe'),
  };
  window.probe = () => {
    if (document.getElementById('probe')) return;
    const button = document.createElement('button');
    button.id = 'probe';
    button.textContent = 'probe';
    button.style.cssText =
      'position:fixed;left:0;bottom:0;width:48px;height:48px;z-index:2147483647';
    button.addEventListener('click', () => window.onProbe?.());
    document.body.append(button);
  };
  window.again = (kind) => {
    window.called = null;
    window.onProbe = () => {
      window.onProbe = null;
      const first = window.result;
      window.called = (async () => {
        first.stop();
        await first.finished;
        const ended = window.items();
        const next = await window.capture().record(kind);
        const both = window.items();
        window.switchTo(kind === 'video' ? 'camera' : 'microphone', false);
        const off = window.items();
        const failed = await next.finished.then(
          () => null,
          (error) => window.failed(error)
        );
        return { ended, both, off, failed, now: Date.now() };
      })();
    };
  };
  window.call = (what) => {
    window.called = null;
    window.onProbe = () => {
      window.onProbe = null;
      const port = window.capture();
      window.called = (what === 'still' ? port.still() : port.record(what)).then(
        (value) => {
          window.result = value;
          window.ended = value.finished?.then(
            () => null,
            (error) => window.failed(error)
          );
          return { ok: true };
        },
        (error) => ({ error: window.failed(error) })
      );
    };
  };
  window.held = () => {
    window.micHold = new Promise((resolve) => {
      window.micRelease = () => {
        window.micHold = null;
        resolve();
      };
    });
  };
  window.attached = () =>
    [...window.composer().shadowRoot.querySelectorAll('swc-upload-attachment')].map((each) => ({
      error: each.hasAttribute('data-error'),
      text: each.textContent.replace(/\s+/g, ' ').trim(),
    }));
  window.boxes = {};
  window.steady = (name) => {
    const target = window.targets[name]();
    const box = target?.getBoundingClientRect();
    if (!box || !(box.width > 0) || target.disabled) return null;
    const seen = JSON.stringify([box.x, box.y, box.width, box.height]);
    const same = window.boxes[name] === seen;
    window.boxes[name] = seen;
    return same ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  };
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

async function press(page, name) {
  await page.evaluate((name) => {
    delete window.boxes[name];
  }, name);
  const { x, y } = await page.until((name) => window.steady(name), name);
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

async function clicked(page, what) {
  await page.evaluate((what) => {
    window.probe();
    window.call(what);
  }, what);
  await press(page, 'probe');
  await page.until(() => !!window.called);
}

const outcome = (page) => page.evaluate(() => window.called);

const failure = (page) => page.evaluate(() => window.ended);

async function takes(page) {
  await page.until(() => window.switchedOn('microphone'));
  return page.evaluate(() => window.recorders.length);
}

async function settled(page, step) {
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.micsLive() === 0);
  assert.deepEqual(page.errors, [], `${step} left page errors: ${JSON.stringify(page.errors)}`);
}

async function recording(page, index, chunks) {
  const ready = (index, chunks) => {
    const { recorder, chunks: seen } = window.take(index);
    return recorder === 'recording' && seen >= chunks;
  };
  try {
    await page.within(10000, ready, index, chunks);
  } catch {
    const seen = await page.evaluate((index) => window.take(index), index);
    assert.fail(
      `take ${index} wanted ${chunks} chunks while recording and after 10 s had ${seen.chunks}, recorder ${seen.recorder}, AudioContext ${seen.context}`
    );
  }
}

async function openMenu(page) {
  await press(page, 'add');
  await page.until(() => !!window.targets['record-audio']());
}

async function chat(page) {
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => !!window.composer()?.shadowRoot);
  await page.until(() => !!window.inComposer('swc-prompt-field')?.shadowRoot);
}

const OFF = (what) => ({
  name: 'NotAllowedError',
  message: `${what} capture is off in seven's settings`,
});
const UNCLICKED = { name: 'NotAllowedError', message: 'the composer captures only inside a click' };

test('the composer’s Record audio records inside the click with no consent and no click item, and the chip’s Stop attaches the recording', async (t) => {
  const page = await seven(t);
  await chat(page);
  await openMenu(page);
  await press(page, 'record-audio');
  await page.until(() => window.chips().some((chip) => chip.startsWith('Recording microphone')));
  assert.match(
    (await page.evaluate(() => window.chips()))[0],
    /^Recording microphone · you · \d+:\d\d/
  );
  const [mic] = await page.evaluate(() =>
    window.mics.map(({ constraints, active }) => ({ constraints, active }))
  );
  assert.deepEqual(mic, { constraints: { audio: true }, active: true });
  assert.equal(await page.evaluate(() => window.sounding()), 'running');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await press(page, 'stop');
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

test('record: only inside a click; stop() finishes a WebM take and releases the microphone, cancel and an empty take discard, a second record is refused, and the Microphone switch refuses and cuts', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    await page.evaluate(() =>
      window
        .capture()
        .record('audio')
        .then(
          () => null,
          (error) => window.failed(error)
        )
    ),
    UNCLICKED
  );
  assert.equal(await page.evaluate(() => window.micCalls), 0);

  const first = await takes(page);
  await clicked(page, 'audio');
  assert.deepEqual(await outcome(page), { ok: true });
  await page.evaluate(() => {
    window.first = window.result;
  });
  await clicked(page, 'audio');
  assert.deepEqual(await outcome(page), {
    error: { name: 'InvalidStateError', message: 'seven is already recording from the composer' },
  });
  await recording(page, first, 6);
  const take = await page.evaluate(async () => {
    const chips = window.chips();
    const state = window.sounding();
    window.first.stop();
    const { blob, mimeType, name, durationMs } = await window.first.finished;
    return {
      chips,
      state,
      mimeType,
      name,
      durationMs,
      type: blob.type,
      size: blob.size,
      head: await window.head(blob),
    };
  });
  assert.match(take.chips[0], /^Recording microphone · you/);
  assert.equal(take.state, 'running');
  assert.equal(take.mimeType, 'audio/webm');
  assert.equal(take.type, 'audio/webm');
  assert.match(take.name, /^recording-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.webm$/);
  assert.ok(take.durationMs >= 1000, String(take.durationMs));
  assert.ok(take.size > 0);
  assert.equal(take.head, '1a 45 df a3');
  await settled(page, 'the stopped take');

  const cancelled = await takes(page);
  await clicked(page, 'audio');
  assert.deepEqual(await outcome(page), { ok: true });
  await recording(page, cancelled, 1);
  await page.evaluate(() => window.result.cancel());
  assert.deepEqual(await failure(page), {
    name: 'AbortError',
    message: 'the recording was cancelled',
  });
  await settled(page, 'the cancelled take');

  await page.evaluate(() => {
    window.silent = true;
  });
  const silent = await takes(page);
  await clicked(page, 'audio');
  assert.deepEqual(await outcome(page), { ok: true });
  await recording(page, silent, 0);
  assert.equal(await page.evaluate(() => window.sounding()), 'suspended');
  await page.evaluate(() => window.result.stop());
  assert.deepEqual(await failure(page), { name: 'AbortError', message: 'nothing was recorded' });
  await page.evaluate(() => {
    window.silent = false;
  });
  await settled(page, 'the empty take');

  const cut = await takes(page);
  await clicked(page, 'audio');
  assert.deepEqual(await outcome(page), { ok: true });
  await recording(page, cut, 1);
  await page.evaluate(() => window.switchTo('microphone', false));
  assert.deepEqual(await failure(page), OFF('microphone'));
  await settled(page, 'the take the switch cut');
  const before = await page.evaluate(() => window.micCalls);
  await clicked(page, 'audio');
  assert.deepEqual(await outcome(page), { error: OFF('microphone') });
  assert.equal(await page.evaluate(() => window.micCalls), before);
  const photo = await page.evaluate(() =>
    window
      .capture()
      .record('photo')
      .then(
        () => null,
        (error) => window.failed(error)
      )
  );
  assert.equal(photo.name, 'NotSupportedError');
  await page.evaluate(() => window.switchTo('microphone', true));
  await page.until(() => window.switchedOn('microphone'));
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('in the composer, Stop or Microphone off while the browser’s microphone prompt is open ends the take at once with nothing attached, the late stream is stopped, and Record audio works again', async (t) => {
  const page = await seven(t);
  await chat(page);
  await page.evaluate(() => window.held());
  await openMenu(page);
  await press(page, 'record-audio');
  await page.until(() => window.chips().length === 1 && window.micCalls === 1);
  await press(page, 'stop');
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.composer().recording === null);
  assert.equal(await page.evaluate(() => window.mics.length), 0);
  assert.deepEqual(await page.evaluate(() => window.attached()), []);
  await page.evaluate(() => window.micRelease());
  await page.until(() => window.mics.length === 1 && window.micsLive() === 0);
  assert.deepEqual(await page.evaluate(() => window.attached()), []);

  await openMenu(page);
  await press(page, 'record-audio');
  await page.until(() => window.chips().some((chip) => chip.startsWith('Recording microphone')));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await press(page, 'stop');
  await page.until(() =>
    window
      .attached()
      .some(
        (each) => !each.error && /recording-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.webm/.test(each.text)
      )
  );
  await page.until(() => window.chips().length === 0 && window.micsLive() === 0);

  await page.evaluate(() => window.held());
  await openMenu(page);
  await press(page, 'record-audio');
  await page.until(() => window.chips().length === 1 && window.micCalls === 3);
  await page.evaluate(() => window.switchTo('microphone', false));
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.attached().filter((each) => each.error).length === 1);
  assert.equal(await page.evaluate(() => window.mics.length), 2);
  await page.evaluate(() => window.micRelease());
  await page.until(() => window.mics.length === 3 && window.micsLive() === 0);
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.deepEqual(page.errors, []);
});

test('still: only inside a click; the picker runs through the screen guards with a Taking a photo chip, seven’s own page is refused, and the Screen switch refuses and cuts', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    await page.evaluate(() =>
      window
        .capture()
        .still()
        .then(
          () => null,
          (error) => window.failed(error)
        )
    ),
    UNCLICKED
  );
  assert.equal(await page.evaluate(() => window.displays.length), 0);

  await page.evaluate(() => {
    window.hold = new Promise((resolve) => {
      window.release = resolve;
    });
  });
  await clicked(page, 'still');
  await page.until(() => window.chips().length > 0);
  const chips = await page.evaluate(() => window.chips());
  await page.evaluate(() => {
    window.hold = null;
    window.release();
  });
  assert.deepEqual(await outcome(page), { ok: true });
  const shot = await page.evaluate(async () => {
    const { blob, mimeType, name } = window.result;
    const [display] = window.displays;
    return {
      mimeType,
      name,
      type: blob.type,
      head: await window.head(blob),
      constraints: display.constraints,
      active: display.active,
      ended: display.track.readyState,
    };
  });
  assert.match(chips[0], /^Taking a photo · you/);
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.type, 'image/png');
  assert.match(shot.name, /^screenshot-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.png$/);
  assert.equal(shot.head, '89 50 4e 47');
  assert.equal(shot.constraints.selfBrowserSurface, 'exclude');
  assert.equal(shot.constraints.surfaceSwitching, 'exclude');
  assert.equal(shot.constraints.preferCurrentTab, false);
  assert.equal(shot.constraints.audio, false);
  assert.equal(shot.active, true);
  assert.equal(shot.ended, 'ended');
  await page.until(() => window.chips().length === 0);

  await page.evaluate(() => {
    window.handle = { handle: 'slicc-seven', origin: location.origin };
  });
  await clicked(page, 'still');
  assert.deepEqual(await outcome(page), {
    error: { name: 'NotAllowedError', message: "seven doesn't capture its own pages or the vault" },
  });
  assert.equal(await page.evaluate(() => window.displays.at(-1).track.readyState), 'ended');
  await page.evaluate(() => {
    window.handle = { handle: 'ordinary', origin: 'https://example.test' };
  });
  await page.until(() => window.chips().length === 0);

  await page.evaluate(() => {
    window.hold = new Promise((resolve) => {
      window.release = resolve;
    });
  });
  await clicked(page, 'still');
  await page.until(() => window.chips().length > 0);
  await page.evaluate(() => window.switchTo('screen', false));
  assert.deepEqual(await outcome(page), { error: OFF('screen') });
  await page.until(() => window.chips().length === 0);
  await page.evaluate(() => {
    window.hold = null;
    window.release();
  });
  await page.until(() => window.displays.at(-1).track.readyState === 'ended');
  const before = await page.evaluate(() => window.displays.length);
  await clicked(page, 'still');
  assert.deepEqual(await outcome(page), { error: OFF('screen') });
  assert.equal(await page.evaluate(() => window.displays.length), before);
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

const VIDEO = /video-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.webm/;

test('the composer’s Record video records the camera with the microphone inside the click with no consent, and Stop attaches a WebM and leaves an ended chip', async (t) => {
  const page = await seven(t);
  assert.deepEqual(await page.evaluate(() => window.capture().kinds), ['audio', 'video']);
  await chat(page);
  await openMenu(page);
  await press(page, 'record-video');
  await page.until(() => window.chips().some((chip) => chip.startsWith('Recording camera')));
  assert.match(
    (await page.evaluate(() => window.chips()))[0],
    /^Recording camera · with microphone · you · \d+:\d\d/
  );
  const opened = await page.evaluate(() =>
    window.mics.map(({ constraints, active }) => ({ constraints, active }))
  );
  assert.deepEqual(opened, [{ constraints: { video: true, audio: true }, active: true }]);
  await recording(page, 0, 4);
  await press(page, 'stop');
  await page.until(
    (pattern) =>
      window.attached().some((each) => !each.error && new RegExp(pattern).test(each.text)),
    VIDEO.source
  );
  await page.until(() => window.micsLive() === 0);
  const seen = await page.until(() => {
    const [chip] = window.shown();
    if (!chip?.ended) return null;
    const [item] = window.items();
    const button = window.targets.stop();
    button.click();
    return { chip, item, after: window.items().length, early: Date.now() - item.endedAt };
  });
  assert.match(seen.chip.text, /^Recorded camera · with microphone · you · Ended/);
  assert.doesNotMatch(seen.chip.text, /\d+:\d\d/);
  assert.equal(seen.chip.action, 'Dismiss');
  assert.equal(seen.item.label, 'Recorded camera');
  assert.equal(seen.item.action.label, 'Dismiss');
  assert.equal(seen.after, 0);
  assert.ok(seen.early < 3000, String(seen.early));
  await page.until(() => window.chips().length === 0);
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('record video: only inside a click, one take at a time, stop() finishes a WebM, cancel discards, and the Camera and Microphone switches each refuse it and cut it', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    await page.evaluate(() =>
      window
        .capture()
        .record('video')
        .then(
          () => null,
          (error) => window.failed(error)
        )
    ),
    UNCLICKED
  );
  assert.equal(await page.evaluate(() => window.micCalls), 0);

  const first = await takes(page);
  await clicked(page, 'video');
  assert.deepEqual(await outcome(page), { ok: true });
  await page.evaluate(() => {
    window.first = window.result;
  });
  for (const kind of ['video', 'audio']) {
    await clicked(page, kind);
    assert.deepEqual(await outcome(page), {
      error: { name: 'InvalidStateError', message: 'seven is already recording from the composer' },
    });
  }
  assert.equal(await page.evaluate(() => window.micCalls), 1);
  await recording(page, first, 4);
  const take = await page.evaluate(async () => {
    window.first.stop();
    const { blob, mimeType, name, durationMs } = await window.first.finished;
    return {
      mimeType,
      name,
      durationMs,
      type: blob.type,
      size: blob.size,
      head: await window.head(blob),
    };
  });
  assert.equal(take.mimeType, 'video/webm');
  assert.equal(take.type, 'video/webm');
  assert.match(take.name, /^video-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.webm$/);
  assert.ok(take.durationMs > 0);
  assert.ok(take.size > 0);
  assert.equal(take.head, '1a 45 df a3');
  await settled(page, 'the stopped video');

  const cancelled = await takes(page);
  await clicked(page, 'video');
  assert.deepEqual(await outcome(page), { ok: true });
  await recording(page, cancelled, 1);
  await page.evaluate(() => window.result.cancel());
  assert.deepEqual(await failure(page), {
    name: 'AbortError',
    message: 'the recording was cancelled',
  });
  await page.until(() => window.items().length === 0);
  await settled(page, 'the cancelled video');

  for (const what of ['camera', 'microphone']) {
    const index = await takes(page);
    await page.until((what) => window.switchedOn(what), what);
    await clicked(page, 'video');
    assert.deepEqual(await outcome(page), { ok: true });
    await recording(page, index, 1);
    await page.evaluate((what) => window.switchTo(what, false), what);
    assert.equal(await page.evaluate(() => window.items().length), 0);
    assert.deepEqual(await failure(page), OFF(what));
    await settled(page, `the video the ${what} switch cut`);
    const before = await page.evaluate(() => window.micCalls);
    await clicked(page, 'video');
    assert.deepEqual(await outcome(page), { error: OFF(what) });
    assert.equal(await page.evaluate(() => window.micCalls), before);
    await page.evaluate((what) => window.switchTo(what, true), what);
  }
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('in the composer, Stop or Camera off while the browser’s camera prompt is open ends the video take at once with nothing attached, the late stream is stopped, and Record video works again', async (t) => {
  const page = await seven(t);
  await chat(page);
  await page.evaluate(() => window.held());
  await openMenu(page);
  await press(page, 'record-video');
  await page.until(() => window.chips().length === 1 && window.micCalls === 1);
  await press(page, 'stop');
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.composer().recording === null);
  assert.deepEqual(await page.evaluate(() => window.items()), []);
  await page.evaluate(() => window.micRelease());
  await page.until(() => window.mics.length === 1 && window.micsLive() === 0);
  assert.deepEqual(await page.evaluate(() => window.attached()), []);

  const index = await takes(page);
  await openMenu(page);
  await press(page, 'record-video');
  await page.until(() => window.chips().some((chip) => chip.startsWith('Recording camera')));
  await recording(page, index, 2);
  await press(page, 'stop');
  await page.until(
    (pattern) =>
      window.attached().some((each) => !each.error && new RegExp(pattern).test(each.text)),
    VIDEO.source
  );
  await page.until(() => window.chips().length === 0 && window.micsLive() === 0);

  await page.evaluate(() => window.held());
  await openMenu(page);
  await press(page, 'record-video');
  await page.until(() => window.chips().length === 1 && window.micCalls === 3);
  await page.evaluate(() => window.switchTo('camera', false));
  await page.until(() => window.chips().length === 0);
  await page.until(() => window.attached().filter((each) => each.error).length === 1);
  await page.evaluate(() => window.micRelease());
  await page.until(() => window.mics.length === 3 && window.micsLive() === 0);
  assert.deepEqual(await page.evaluate(() => window.asked), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.deepEqual(page.errors, []);
});

test('a take that ends keeps its chip for 3 s as ended with Dismiss: a new take shows next to it, a switch turned off leaves it, and it goes on its own', async (t) => {
  const page = await seven(t);
  for (const [kind, past, live] of [
    ['audio', 'Recorded microphone', 'Recording microphone'],
    ['video', 'Recorded camera', 'Recording camera'],
  ]) {
    const index = await takes(page);
    await page.until(() => window.switchedOn('camera'));
    await clicked(page, kind);
    assert.deepEqual(await outcome(page), { ok: true });
    await recording(page, index, 2);
    await page.evaluate((kind) => {
      window.probe();
      window.again(kind);
    }, kind);
    await press(page, 'probe');
    await page.until(() => !!window.called);
    const { ended, both, off, failed, now } = await outcome(page);
    const shape = (list) =>
      list.map(({ label, asker, endedAt, action }) => ({
        label,
        asker,
        ended: typeof endedAt === 'number',
        action: action.label,
      }));
    const over = { label: past, asker: 'you', ended: true, action: 'Dismiss' };
    assert.deepEqual(shape(ended), [over]);
    assert.deepEqual(shape(both), [
      over,
      { label: live, asker: 'you', ended: false, action: 'Stop' },
    ]);
    assert.deepEqual(shape(off), [over]);
    assert.deepEqual(failed, OFF(kind === 'video' ? 'camera' : 'microphone'));
    assert.ok(now - ended[0].endedAt < 3000, String(now - ended[0].endedAt));
    await page.until(() => window.items().length === 0);
    const gone = await page.evaluate((endedAt) => Date.now() - endedAt, ended[0].endedAt);
    assert.ok(gone >= 2900, String(gone));
    await page.evaluate(
      (what) => window.switchTo(what, true),
      kind === 'video' ? 'camera' : 'microphone'
    );
    await settled(page, `the ${kind} take`);
  }
  assert.deepEqual(page.errors, []);
});
