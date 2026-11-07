import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const faux = () => {
  globalThis.sliccKernelDebug = true;
  window.faux = { answer: 'once', seen: [] };
  globalThis.sliccCaptureAgent = {
    approveCapture: async (request, options) => {
      window.faux.seen.push({
        kind: request.kind,
        options: request.options,
        tag: request.stamp?.tag ?? null,
        tags: request.stamp?.tags ?? [],
        users: request.stamp?.users ?? null,
        label: request.label ?? null,
        signal: options?.signal instanceof AbortSignal,
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
  window.micState = 'granted';
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor) =>
    descriptor?.name === 'microphone'
      ? Promise.resolve({ state: window.micState })
      : query(descriptor);
  window.recognitions = 0;
  window.SpeechRecognition = class {
    constructor() {
      window.recognitions += 1;
    }
    start() {}
    stop() {
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
  };
  window.displays = [];
  window.mics = [];
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      window.displays.push({ active: navigator.userActivation.isActive });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      const paint = () => {
        context.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`;
        context.fillRect(0, 0, 64, 64);
      };
      paint();
      const timer = setInterval(paint, 50);
      const stream = canvas.captureStream(10);
      const [track] = stream.getVideoTracks();
      const stop = track.stop.bind(track);
      track.stop = () => {
        clearInterval(timer);
        stop();
      };
      track.getCaptureHandle = () => ({ handle: 'ordinary', origin: 'https://example.test' });
      return stream;
    },
  });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async () => {
      window.mics.push({ active: navigator.userActivation.isActive });
      const context = new AudioContext();
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return out.stream;
    },
  });
};

async function seven(t, page = null) {
  const opened = page ?? (await chrome.page(t));
  await opened.init(faux);
  await boot(opened);
  return opened;
}

const answer = (page, value) =>
  page.evaluate((value) => {
    window.faux.answer = value;
  }, value);

async function pressDeep(page, selector) {
  await page.until((selector) => {
    const box = window.deep(selector)?.getBoundingClientRect();
    return !!box && box.width > 0;
  }, selector);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const { x, y } = await page.evaluate((selector) => {
    const box = window.deep(selector).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, selector);
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const CLICK = 'dialog[data-kind="click"]';

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

test('with the agent answering once, a typed screencapture records with no dialog, and a background one shows only the click item, whose action runs the picker inside the click', async (t) => {
  const page = await seven(t);
  await run(page, 'screencapture -x /tmp/typed.png; echo "typed $?"');
  await shows(page, 'typed 0');
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  const [typed] = await page.evaluate(() => window.faux.seen);
  assert.equal(typed.kind, 'capture.screen');
  assert.equal(typed.signal, true);
  assert.match(typed.tag, /"where":"terminal:/);

  await run(page, 'sleep 8; screencapture -x /tmp/background.png; echo "background $?"');
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.subject, 'capture');
  assert.equal(item.what, 'screen');
  assert.equal(item.here, true);
  assert.equal(item.action, 'Choose what to share');
  assert.equal(item.title, 'Choose what to share?');
  assert.match(
    item.body,
    /A program asks seven to capture your screen\. You pick what to share next\./
  );
  assert.ok(item.expiresAt - item.createdAt === 300000);
  await shows(page, "waiting for a click in seven's tab: choose what to share");
  assert.equal(await page.evaluate(() => window.displays.length), 1);
  await shoot(page, 'capture-click-item');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await shows(page, 'background 0');
  assert.deepEqual(await page.evaluate(() => window.displays), [
    { active: true },
    { active: true },
  ]);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a microphone recording asks for a click only while the browser would prompt, and a blocked one fails at once', async (t) => {
  const page = await seven(t);
  const record = (name) =>
    `sleep 8; exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"audio.record","seconds":1}' >&3; cat <&3 > /dev/null; echo "${name} $?"; exec 3<&-`;
  await run(page, record('granted'));
  await shows(page, 'granted 0', 60000);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  await page.evaluate(() => {
    window.micState = 'prompt';
  });
  await run(page, record('prompt'));
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.action, 'Allow microphone');
  assert.equal(item.what, 'microphone');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await shows(page, 'prompt 0', 60000);
  assert.equal(await page.evaluate(() => window.mics.at(-1).active), true);

  await page.evaluate(() => {
    window.micState = 'denied';
  });
  await run(page, record('denied'));
  await shows(page, 'microphone permission is blocked for this site');
  await shows(page, 'denied 1');
  assert.equal(await page.evaluate(() => window.mics.length), 2);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a deny with a message reaches the program as EACCES with that message, EAGAIN shows seven’s own prompt, and Cancel on the click item refuses', async (t) => {
  const page = await seven(t);
  await answer(page, { answer: 'deny', message: 'capture: denied by the approval judge: not now' });
  await run(
    page,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "denied $?"`
  );
  await shows(page, 'capture: denied by the approval judge: not now');
  await shows(page, 'denied 1');
  assert.equal(await page.evaluate(() => window.displays.length), 0);

  await answer(page, 'EAGAIN');
  await run(page, 'sleep 8; screencapture -x /tmp/fallback.png; echo "fallback $?"');
  await pressConfirm(page, 'cancel');
  await shows(page, 'fallback 1');
  assert.equal(await page.evaluate(() => window.prompted), 1);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  await answer(page, 'once');
  await run(page, 'sleep 12; screencapture -x /tmp/cancelled.png; echo "cancelled $?"');
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="deny"]`);
  await shows(page, 'cancelled 1');
  assert.equal(await page.evaluate(() => window.displays.length), 0);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.deepEqual(page.errors, []);
});

test('a guest-tainted process reaches the agent with its tags', async (t) => {
  const page = await seven(t);
  await answer(page, { answer: 'deny', message: 'capture: the guest’s seat said no' });
  const result = await page.evaluate(async () => {
    const client = await globalThis.sliccRequestsClient();
    try {
      return await client.run(
        [
          'sh',
          '-c',
          `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "guest $?"`,
        ],
        { tag: 'slicc-taint:guest-seat-1' }
      );
    } finally {
      await client.close();
    }
  });
  assert.match(result.stdout, /guest 1/);
  assert.match(result.stderr, /capture: the guest’s seat said no/);
  const [seen] = await page.evaluate(() => window.faux.seen);
  assert.ok([seen.tag, ...seen.tags].includes('slicc-taint:guest-seat-1'), JSON.stringify(seen));
  assert.equal(await page.evaluate(() => window.displays.length), 0);
  assert.deepEqual(page.errors, []);
});

test('a hidden tab marks its title while a click waits, and another tab shows the click with here false and can only cancel it', async (t) => {
  const a = await seven(t);
  const b = await seven(t, await a.tab());
  await a.send('Page.bringToFront');
  await run(a, 'sleep 8; screencapture -x /tmp/elsewhere.png; echo "elsewhere $?"');
  await a.until(() => window.clickItems().length === 1);
  const title = await a.evaluate(() => document.title);
  await a.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await a.evaluate(() => document.title), `● ${title}`);
  await a.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await a.evaluate(() => document.title), title);
  await a.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await b.send('Page.bringToFront');
  await b.until(() => window.clickItems().length === 1);
  const [there] = await b.evaluate(() => window.clickItems());
  assert.equal(there.here, false);
  await b.until(
    (selector) => /Click in seven’s tab\./.test(window.deep(selector)?.textContent ?? ''),
    CLICK
  );
  assert.equal(
    await b.evaluate(
      (selector) => !!window.deep(selector)?.querySelector('[data-action="once"]'),
      CLICK
    ),
    false
  );
  await shoot(b, 'capture-click-elsewhere');
  await pressDeep(b, `${CLICK} [data-action="deny"]`);
  await shows(a, 'elsewhere 1');
  await a.until(() => window.clickItems().length === 0);
  assert.equal(await a.evaluate(() => document.title), title);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});

test('the indicator shows while a recording runs, Stop ends it so the program keeps a finished file, and the chip goes with the request', async (t) => {
  const page = await seven(t);
  await run(
    page,
    'screencapture -V 60 /tmp/stopped.webm; echo "screen $?"; test -s /tmp/stopped.webm && echo "screen file kept"'
  );
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /Recording screen · a terminal · \d+:\d\d/);
  await shoot(page, 'capture-live-chip');
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await shows(page, 'screen 0', 60000);
  await shows(page, 'screen file kept');
  await page.until(() => window.chips().length === 0);

  await run(
    page,
    `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"audio.record","seconds":60}' >&3; cat <&3 > /tmp/mic.webm; echo "mic $?"; exec 3<&-`
  );
  await page.until(() => window.chips().some((chip) => chip.startsWith('Recording microphone')));
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await shows(page, 'mic 0', 60000);
  await page.until(() => window.chips().length === 0);

  await run(
    page,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png","delay":60}' | cat > /dev/embedder; echo "still $?"`
  );
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await shows(page, 'stopped in seven');
  await shows(page, 'still 1');
  await page.until(() => window.chips().length === 0);

  await run(page, 'timeout 3 screencapture -V 60 /tmp/killed.webm; echo "killed $?"');
  await page.until(() => window.chips().length === 1);
  await shows(page, 'killed ', 60000);
  await page.until(() => window.chips().length === 0);
  assert.deepEqual(page.errors, []);
});

test('each switch refuses its kind before the agent is asked, ends a live capture when turned off, survives a reload, and no program can reach it', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    await page.evaluate(() => document.querySelector('slicc-app').model.switches.list()),
    [
      { key: 'camera', label: 'Camera', on: true },
      { key: 'microphone', label: 'Microphone', on: true },
      { key: 'screen', label: 'Screen', on: true },
    ]
  );
  await run(page, 'screencapture -V 60 /tmp/cut.webm; echo "cut $?"');
  await page.until(() => window.chips().length === 1 && window.displays.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('screen', false)
  );
  await shows(page, 'cut 0', 60000);
  await page.until(() => window.chips().length === 0);

  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('microphone', false)
  );
  const before = await page.evaluate(() => window.faux.seen.length);
  await run(
    page,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "screen off $?"`
  );
  await shows(page, "screen capture is off in seven's settings");
  await shows(page, 'screen off 1');
  await run(
    page,
    `printf '%s\\n' '{"kind":"audio.record","seconds":1}' | cat > /dev/embedder; echo "mic off $?"`
  );
  await shows(page, "microphone capture is off in seven's settings");
  await shows(page, 'mic off 1');
  assert.equal(await page.evaluate(() => window.faux.seen.length), before);
  assert.equal(await page.evaluate(() => window.displays.length), 1);

  await run(
    page,
    'grep -rlsF slicc-os.switches /etc /home /root /tmp /var 2>/dev/null; echo "kernel files checked"'
  );
  await shows(page, 'kernel files checked');
  const screen = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.doesNotMatch(screen.replace(/grep -rlsF slicc-os\.switches/, ''), /slicc-os\.switches/);

  await page.reload();
  await ready(page);
  assert.deepEqual(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.switches.list()
        .map(({ key, on }) => [key, on])
    ),
    [
      ['camera', true],
      ['microphone', false],
      ['screen', false],
    ]
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.deep('[data-surface="switches"] [data-id="screen"]'));
  assert.equal(
    await page.evaluate(() => window.deep('[data-surface="switches"] [data-id="screen"]').checked),
    false
  );
  await shoot(page, 'capture-switches');
  await run(page, 'screencapture -x /tmp/still-off.png; echo "still off $?"');
  await shows(page, 'still off 1');
  assert.deepEqual(page.errors, []);
});

test('the Microphone switch also covers a transcribe that listens: it shows a chip, turning the switch off ends it, and then it is refused while probes still answer', async (t) => {
  const page = await seven(t);
  const listen = (name) =>
    `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"audio.transcribe","engine":"webspeech","seconds":60}' >&3; cat <&3; echo "${name} $?"; exec 3<&-`;
  await run(page, listen('listening'));
  await page.until(() => window.chips().some((chip) => chip.startsWith('Recording microphone')));
  await page.until(() => window.recognitions === 1);
  assert.deepEqual(await page.evaluate(() => window.faux.seen), []);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('microphone', false)
  );
  await shows(page, 'listening 0', 60000);
  await page.until(() => window.chips().length === 0);

  await run(page, listen('refused'));
  await shows(page, "microphone capture is off in seven's settings");
  await shows(page, 'refused 1');
  assert.equal(await page.evaluate(() => window.recognitions), 1);
  await run(
    page,
    `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"audio.transcribe","status":true}' >&3; cat <&3; echo "probe $?"; exec 3<&-`
  );
  await shows(page, 'platform: ready (Web Speech)');
  await shows(page, 'probe 0');
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('turning Screen off while a click item waits refuses the request even after the click', async (t) => {
  const page = await seven(t);
  await run(
    page,
    `sleep 8; printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "waited $?"`
  );
  await page.until(() => window.clickItems().length === 1);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('screen', false)
  );
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await shows(page, "screen capture is off in seven's settings");
  await shows(page, 'waited 1');
  assert.equal(await page.evaluate(() => window.displays.length), 0);
  await page.evaluate(() => document.querySelector('slicc-app').model.switches.set('screen', true));
  assert.deepEqual(page.errors, []);
});

test('a click nobody answers times out after 5 minutes with nobody clicked within 5 min', async (t) => {
  const page = await seven(t);
  await run(
    page,
    `sleep 8; printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "late $?"`
  );
  await page.until(() => window.clickItems().length === 1);
  await shows(page, 'nobody clicked within 5 min', 330000);
  await shows(page, 'late 1');
  await page.until(() => window.clickItems().length === 0);
  assert.equal(await page.evaluate(() => window.displays.length), 0);
  assert.deepEqual(page.errors, []);
});
