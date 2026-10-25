import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
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
  window.micOpened = 0;
  window.recognitions = 0;
  window.prompted = 0;
  window.SpeechRecognition = class {
    constructor() {
      window.recognitions += 1;
    }
    start() {}
    stop() {}
    abort() {}
  };
  new MutationObserver(() => {
    if (window.findConfirm() && !window.prompting) {
      window.prompting = true;
      window.prompted += 1;
    }
    if (!window.findConfirm()) window.prompting = false;
  }).observe(document, { childList: true, subtree: true });
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
    configurable: true,
    writable: true,
    value: async () => {
      window.micOpened += 1;
      throw new DOMException('denied by the test', 'NotAllowedError');
    },
  });
`;

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

const ask = (header) => `printf '%s\\n' '${JSON.stringify(header)}' | cat > /dev/embedder`;

test('slicc-audio is in the base set without ortllama, a delayed microphone request asks and Cancel leaves the mic unopened, a typed one goes ahead, and probes never ask', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(page);

  await run(
    page,
    'test -d /node_modules/@ai-ecoverse/slicc-audio && echo audio-in; test -e /node_modules/@ai-ecoverse/slicc-ortllama || echo no-ortllama; test -e /node_modules/onnxruntime-web || echo no-onnx; echo "commands $(command -v afplay say hear chime | wc -l)"'
  );
  await shows(page, 'audio-in');
  await shows(page, 'no-ortllama');
  await shows(page, 'no-onnx');
  await shows(page, 'commands 4');

  await run(page, `sleep 8; ${ask({ kind: 'audio.record', seconds: 1 })}; echo "rec $?"`);
  await page.until(() => !!window.findConfirm(), undefined);
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /Use the microphone\?.*A program asks seven to record from your microphone\./s
  );
  await page.screenshot(new URL('mic-prompt-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('mic-prompt-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.until(() => document.documentElement.clientWidth === 420);
  await page.screenshot(new URL('mic-prompt-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await press(page, 'cancel');
  await shows(page, 'the request to use the microphone was dismissed');
  await shows(page, 'rec 1');
  assert.equal(await page.evaluate(() => window.micOpened), 0);

  await run(page, `${ask({ kind: 'audio.record', seconds: 1 })}; echo "typed $?"`);
  await shows(page, 'microphone permission denied');
  await shows(page, 'typed 1');
  assert.equal(await page.evaluate(() => window.micOpened), 1);
  assert.equal(await page.evaluate(() => window.prompted), 1);

  await run(
    page,
    `sleep 12; ${ask({ kind: 'audio.transcribe', engine: 'mystery' })}; echo "mystery $?"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /Use the microphone\?.*A program asks seven to listen through your microphone\./s
  );
  await press(page, 'cancel');
  await shows(page, 'mystery 1');
  assert.equal(await page.evaluate(() => window.micOpened), 1);
  assert.equal(await page.evaluate(() => window.prompted), 2);

  await run(
    page,
    `sleep 12; { printf '%s\\n' '{"kind":"audio.transcribe","engine":"webspeech"}'; printf 'x'; } | cat > /dev/embedder; echo "carried $?"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  await press(page, 'cancel');
  await shows(page, 'carried 1');
  assert.equal(await page.evaluate(() => window.micOpened), 1);
  assert.equal(await page.evaluate(() => window.recognitions), 0);
  assert.equal(await page.evaluate(() => window.prompted), 3);

  await run(
    page,
    `sleep 12; ${ask({ kind: 'audio.transcribe', engine: 'webspeech', devices: true })}; echo "devices $?"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  await press(page, 'cancel');
  await shows(page, 'devices 1');
  assert.equal(await page.evaluate(() => window.recognitions), 0);
  assert.equal(await page.evaluate(() => window.micOpened), 1);
  assert.equal(await page.evaluate(() => window.prompted), 4);

  await run(
    page,
    `sleep 8; exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"audio.transcribe","status":true}' >&3; cat <&3; exec 3<&-; echo "probed"; ${ask({ kind: 'audio.voices' })}; echo "voices $?"`
  );
  await shows(page, 'ortllama: no server at');
  await shows(page, 'probed');
  await shows(page, 'voices');
  assert.equal(await page.evaluate(() => window.prompted), 4);
  assert.equal(await page.evaluate(() => window.recognitions), 0);
  assert.equal(await page.evaluate(() => window.micOpened), 1);
  assert.deepEqual(page.errors, []);
});
