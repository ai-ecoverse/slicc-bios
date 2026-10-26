import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const TITLE = 'Capture target';
const chrome = await launch({
  persistent: true,
  args: [`--auto-select-desktop-capture-source=${TITLE}`],
});
after(() => chrome.close());

const helpers = `
  window.findConfirm = () => {
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-confirm') return element;
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(document);
  };
  window.copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => '',
      writeText: async () => {},
      write: async (items) => {
        for (const item of items)
          for (const type of item.types) {
            const blob = await item.getType(type);
            const head = [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())];
            window.copied.push({ type, size: blob.size, head });
          }
      },
    },
  });
`;

const PNG = '89 50 4e 47';

const NAMED =
  "<script>navigator.mediaDevices.setCaptureHandleConfig({ handle: 'capture-target', exposeOrigin: true, permittedOrigins: ['*'] });</script>";

let targets = 0;

async function target(then = NAMED) {
  const html = `<!doctype html><title>loading</title>${then}<script>document.title = ${JSON.stringify(TITLE)};</script><body style="margin:0;background:#0a6"><h1>dummy</h1>`;
  const path = `/capture-target-${(targets += 1)}.html`;
  chrome.overrides.set(path, html);
  const url = new URL(path, chrome.url);
  url.hostname = 'localhost';
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: url.href,
    background: true,
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const seen = targetInfos.find((info) => info.targetId === targetId);
    if (seen?.title === TITLE) break;
    if (Date.now() > deadline)
      throw new Error(
        `the dummy tab ${url.href} never set its title to ${JSON.stringify(TITLE)} (${seen ? `last title: ${JSON.stringify(seen.title)}` : 'the target is gone'})`
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return () => chrome.cdp.send('Target.closeTarget', { targetId });
}

async function press(page, which) {
  await page.until(
    (which) => !!window.findConfirm()?.shadowRoot?.querySelector(`[data-${which}]`),
    which
  );
  const { x, y } = await page.evaluate((which) => {
    const box = window
      .findConfirm()
      .shadowRoot.querySelector(`[data-${which}]`)
      .getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, which);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

const magic = (file) => `od -An -tx1 -N4 ${file} | tr -s ' ' | sed 's/^ //'`;

test('screencapture through /dev/embedder: typed it captures the picked tab, delayed it asks first, Cancel refuses, and -c copies the PNG', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(page);
  const close = await target();

  await run(page, `screencapture -x /tmp/typed.png; echo "typed $? $(${magic('/tmp/typed.png')})"`);
  await shows(page, `typed 0 ${PNG}`);
  assert.equal(await page.evaluate(() => window.findConfirm()), null);

  await run(
    page,
    `sleep 8; screencapture -x /tmp/late.png; echo "late $? $(${magic('/tmp/late.png')})"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /Capture the screen\?.*A program asks seven to capture your screen\. You pick what to share next\./s
  );
  await page.screenshot(new URL('capture-prompt-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('capture-prompt-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.until(() => document.documentElement.clientWidth === 420);
  await page.screenshot(new URL('capture-prompt-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await press(page, 'action');
  await shows(page, `late 0 ${PNG}`);

  await run(page, `sleep 8; screencapture -x /tmp/no.png; echo "no $?"; ls /tmp/no.png`);
  await page.until(() => !!window.findConfirm(), undefined);
  await press(page, 'cancel');
  await shows(page, 'no 1');
  await shows(page, 'No such file or directory');

  await run(page, 'sleep 12; screencapture -c; echo "clip $?"');
  await page.until(() => !!window.findConfirm(), undefined);
  await press(page, 'action');
  await shows(page, 'KB to clipboard');
  await shows(page, 'clip 0');
  const copied = await page.evaluate(() => window.copied);
  assert.equal(copied.length, 1, JSON.stringify(copied));
  assert.equal(copied[0].type, 'image/png');
  assert.ok(copied[0].size > 100, JSON.stringify(copied));
  assert.deepEqual(copied[0].head, [0x89, 0x50, 0x4e, 0x47]);

  await run(
    page,
    `{ printf '%s\\n' '{"kind":"clipboard.write","type":"image/png"}'; head -c 17000000 /dev/zero; } | cat > /dev/embedder; echo "big $?"`
  );
  await shows(page, 'seven copies at most 16 MB to the clipboard');
  await shows(page, 'big 1');
  assert.equal((await page.evaluate(() => window.copied)).length, 1);

  await close();
  assert.deepEqual(page.errors, []);
});

test('a capture that lands on another of seven’s tabs is stopped and refused', async (t) => {
  const a = await chrome.page(t);
  await a.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(a);
  const b = await a.tab();
  await boot(b);
  await b.evaluate((title) => {
    document.title = title;
    new MutationObserver(() => {
      if (document.title !== title) document.title = title;
    }).observe(document.querySelector('title') ?? document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, TITLE);
  await a.send('Page.bringToFront');
  const seven = await a.evaluate(() => location.origin);
  const { result, exceptionDetails } = await a.send('Runtime.evaluate', {
    expression: `(async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, selfBrowserSurface: 'exclude' });
      const [track] = stream.getVideoTracks();
      const started = Date.now();
      while (!track.getCaptureHandle() && Date.now() - started < 10000)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const found = { handle: track.getCaptureHandle(), after: Date.now() - started, surface: track.getSettings().displaySurface };
      for (const each of stream.getTracks()) each.stop();
      return found;
    })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  assert.equal(exceptionDetails, undefined, exceptionDetails?.exception?.description);
  t.diagnostic(`seven's capture handle: ${JSON.stringify(result.value)}`);
  assert.deepEqual(result.value.handle, { handle: 'slicc-seven', origin: seven });
  await run(
    a,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "own $?"`
  );
  await shows(a, "seven doesn't capture its own pages or the vault");
  await shows(a, 'own 1');
  assert.equal(await a.evaluate(() => window.findConfirm()), null);
  assert.deepEqual(a.errors, []);
});

test('a capture whose tab navigates to seven while it waits is stopped and refused, as soon as its handle goes', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(page);
  const seven = await page.evaluate(() => location.origin);
  const close = await target(
    `${NAMED}<script>setTimeout(() => location.assign(${JSON.stringify(`${seven}/os/`)}), 8000)</script>`
  );
  await run(
    page,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png","delay":45}' | cat > /dev/embedder; echo "nav $?"`
  );
  await shows(page, 'nav 1', 120000);
  const said = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.match(
    said.replace(/\s+/g, ' '),
    /\/dev\/embedder: (seven doesn't capture its own pages or the vault|seven can't tell this tab isn't its own or the vault's)/
  );
  assert.equal(await page.evaluate(() => window.findConfirm()), null);
  await close();
  assert.deepEqual(page.errors, []);
});

test('a capture that lands on a vault tab is refused, and seven’s own tab is never offered', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(page);
  const close = await target(
    `<script>navigator.mediaDevices.setCaptureHandleConfig({ handle: 'slicc-vault', exposeOrigin: true, permittedOrigins: ['*'] });</script>`
  );
  await run(
    page,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "vault $?"`
  );
  await shows(page, "seven doesn't capture its own pages or the vault");
  await shows(page, 'vault 1');
  await close();

  await page.evaluate((title) => {
    document.title = title;
  }, TITLE);
  await run(
    page,
    'timeout 60 sh -c \'screencapture -x /tmp/self.png\'; echo "self $?"; ls /tmp/self.png'
  );
  await shows(page, 'No such file or directory', 90000);
  const text = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.match(text, /self [1-9]/);
  assert.deepEqual(page.errors, []);
});

test('a tab that sets no capture handle is refused, since seven can’t tell it isn’t its own or the vault', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(page);
  const close = await target('');
  await run(
    page,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "bare $?"`
  );
  await shows(page, "seven can't tell this tab isn't its own or the vault's");
  await shows(page, 'bare 1');
  await close();
  assert.deepEqual(page.errors, []);
});

const videoDevices = `
  window.displayOpened = [];
  window.micOpened = [];
  window.prompted = 0;
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...args) {
    if (this.getRootNode()?.host?.localName === 'slicc-confirm') window.prompted += 1;
    return showModal.apply(this, args);
  };
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async (constraints) => {
      window.displayOpened.push(constraints);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      const paint = () => {
        context.fillStyle = '#0a6';
        context.fillRect(0, 0, 64, 64);
      };
      paint();
      const stream = canvas.captureStream(10);
      const [track] = stream.getVideoTracks();
      const timer = setInterval(paint, 50);
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
    value: async (constraints) => {
      window.micOpened.push(constraints);
      throw new DOMException('denied by the test', 'NotAllowedError');
    },
  });
`;

test('a typed video asks the picker for shared sound only with -A', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers + videoDevices });
  await boot(page);
  for (const [name, flag] of [
    ['silent', ''],
    ['sound', '-A'],
  ]) {
    await run(
      page,
      `screencapture -V 0.5 ${flag} /tmp/${name}.webm; echo "${name} $?"; wc -c /tmp/${name}.webm`
    );
    await shows(page, `${name} 0`);
  }
  const constraints = await page.evaluate(() => window.displayOpened);
  assert.deepEqual(
    constraints.map((value) => value.audio),
    [false, true]
  );
  for (const value of constraints) {
    assert.equal(value.selfBrowserSurface, 'exclude');
    assert.equal(value.surfaceSwitching, 'exclude');
    assert.equal(value.preferCurrentTab, false);
  }
  assert.deepEqual(await page.evaluate(() => window.micOpened), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('shared sound is named before the picker, and Cancel opens nothing', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers + videoDevices });
  await boot(page);
  await run(page, 'sleep 8; screencapture -V 5 -A /tmp/sound.webm; echo "sound cancelled $?"');
  await page.until(() => !!window.findConfirm());
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /Capture the screen\?.*A program asks seven to capture your screen and its sound\. You pick what to share next\./s
  );
  await shoot(page, 'capture-sound-prompt');
  await press(page, 'cancel');
  await shows(page, 'the request to capture the screen was dismissed');
  await shows(page, 'sound cancelled 1');
  assert.deepEqual(await page.evaluate(() => window.displayOpened), []);
  assert.deepEqual(await page.evaluate(() => window.micOpened), []);
  assert.deepEqual(page.errors, []);
});

test('screen, shared sound and microphone use one duration-bearing prompt, and Cancel opens neither device', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers + videoDevices });
  await boot(page);
  await run(page, 'sleep 8; screencapture -V 5 -A -g /tmp/mic.webm; echo "mic cancelled $?"');
  await page.until(() => !!window.findConfirm());
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /Capture the screen and microphone\?.*A program asks seven to capture your screen and its sound, and record from your microphone for up to 5 seconds\. You pick what to share next\./s
  );
  await shoot(page, 'capture-microphone-prompt');
  await press(page, 'cancel');
  await shows(page, 'the request to capture the screen was dismissed');
  await shows(page, 'mic cancelled 1');
  assert.equal(await page.evaluate(() => window.prompted), 1);
  assert.deepEqual(await page.evaluate(() => window.displayOpened), []);
  assert.deepEqual(await page.evaluate(() => window.micOpened), []);
  assert.deepEqual(page.errors, []);
});

test('typed -g and -G in an active tab request only the default or exact named microphone', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers + videoDevices });
  await boot(page);
  for (const [name, flag] of [
    ['default', '-g'],
    ['named', '-G dummy-mic'],
  ]) {
    await run(page, `screencapture -V 1 ${flag} /tmp/${name}.webm; echo "${name} mic $?"`);
    await shows(page, `${name} mic 1`);
  }
  assert.deepEqual(await page.evaluate(() => window.micOpened), [
    { audio: true, video: false },
    { audio: { deviceId: { exact: 'dummy-mic' } }, video: false },
  ]);
  assert.deepEqual(await page.evaluate(() => window.displayOpened.map((value) => value.audio)), [
    false,
    false,
  ]);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

const standIn = `
  window.fakeCaptures = [];
  const make = (mode) => {
    const track = new EventTarget();
    let handle = null;
    track.kind = 'video';
    track.readyState = 'live';
    track.stop = () => {
      track.readyState = 'ended';
      window.fakeCaptures.push(mode + ':stopped');
    };
    track.getCaptureHandle = () => handle;
    track.getSettings = () => (mode === 'unknown' ? {} : { displaySurface: 'browser' });
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    if (mode === 'flip')
      setTimeout(() => {
        handle = { handle: 'slicc-seven', origin: location.origin };
        track.dispatchEvent(new Event('capturehandlechange'));
        handle = { handle: 'ordinary', origin: 'https://example.test' };
        window.fakeCaptures.push('flip:flipped');
      }, 200);
    return stream;
  };
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => make(window.fakeMode),
  });
`;

test('through a stand-in picker: a handle that is seven’s for a moment while seven waits is refused, and so is a surface that isn’t a window or screen', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: standIn });
  await boot(page);
  const ask = `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder`;

  await page.evaluate(() => {
    window.fakeMode = 'flip';
  });
  await run(page, `${ask}; echo "flip $?"`);
  await shows(page, "seven doesn't capture its own pages or the vault");
  await shows(page, 'flip 1');
  assert.deepEqual(await page.evaluate(() => window.fakeCaptures), [
    'flip:stopped',
    'flip:flipped',
  ]);

  await page.evaluate(() => {
    window.fakeMode = 'unknown';
    window.fakeCaptures.length = 0;
  });
  await run(page, `${ask}; echo "unknown $?"`);
  await shows(page, "seven can't tell this tab isn't its own or the vault's");
  await shows(page, 'unknown 1');
  assert.deepEqual(await page.evaluate(() => window.fakeCaptures), ['unknown:stopped']);
  assert.deepEqual(page.errors, []);
});
