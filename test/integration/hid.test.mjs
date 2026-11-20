import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { boot, pressDeep, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const PINNED = JSON.parse(
  readFileSync(new URL('../../src/packages/package.json', import.meta.url), 'utf8')
).dependencies['@ai-ecoverse/slicc-devices'];
const chrome = await launch({ tools: false });
after(() => chrome.close());

const AGENT = '{"kind":"agent","agentId":"cone:cone"}';
const CLICK = 'dialog[data-kind="click"]';

const faux = () => {
  globalThis.sliccKernelDebug = true;
  window.hidLog = {
    chooser: [],
    opened: 0,
    closed: 0,
    sent: [],
    features: [],
    asked: [],
    held: [],
  };
  const gates = {};
  window.hold = (what) => {
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    gates[what] = { gate, release };
  };
  window.release = (what) => {
    const held = gates[what];
    delete gates[what];
    held?.release();
  };
  const passed = async (what) => {
    const held = gates[what];
    if (!held) return;
    window.hidLog.held.push(what);
    await held.gate;
  };
  class FakeDevice extends EventTarget {
    constructor() {
      super();
      this.vendorId = 0x320f;
      this.productId = 0x5044;
      this.productName = 'Nano Pad';
      this.collections = [{ usagePage: 0xff60, usage: 0x61 }];
      this.opened = false;
      this.listening = 0;
    }
    addEventListener(type, listener, options) {
      if (type === 'inputreport') this.listening += 1;
      return super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      if (type === 'inputreport') this.listening -= 1;
      return super.removeEventListener(type, listener, options);
    }
    async open() {
      if (this.opened) throw new DOMException('The device is already open.', 'InvalidStateError');
      await passed('open');
      this.opened = true;
      window.hidLog.opened += 1;
    }
    async close() {
      this.opened = false;
      window.hidLog.closed += 1;
    }
    async sendReport(reportId, data) {
      window.hidLog.sent.push([reportId, [...new Uint8Array(data)]]);
    }
    async sendFeatureReport(reportId, data) {
      window.hidLog.features.push([reportId, [...new Uint8Array(data)]]);
    }
    async receiveFeatureReport(reportId) {
      window.hidLog.asked.push(reportId);
      return new DataView(Uint8Array.from([reportId, 0x0a, 0x0b]).buffer);
    }
  }
  const device = new FakeDevice();
  const granted = [];
  const hid = new EventTarget();
  hid.getDevices = async () => [...granted];
  hid.requestDevice = async ({ filters } = {}) => {
    const active = navigator.userActivation.isActive;
    window.hidLog.chooser.push({ active, filters });
    if (!active)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    await passed('chooser');
    if (!granted.includes(device)) granted.push(device);
    return [device];
  };
  Object.defineProperty(Navigator.prototype, 'hid', { configurable: true, get: () => hid });
  window.grant = () => {
    if (!granted.includes(device)) granted.push(device);
  };
  window.unplug = () => {
    granted.splice(granted.indexOf(device), 1);
    const event = new Event('disconnect');
    Object.defineProperty(event, 'device', { value: device });
    hid.dispatchEvent(event);
  };
  window.report = (reportId, bytes) => {
    const event = new Event('inputreport');
    Object.defineProperty(event, 'device', { value: device });
    Object.defineProperty(event, 'reportId', { value: reportId });
    Object.defineProperty(event, 'data', { value: new DataView(Uint8Array.from(bytes).buffer) });
    device.dispatchEvent(event);
  };
  window.hidOpen = () => device.opened;
  window.hidListening = () => device.listening;
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
  window.runs = [];
  window.background = (command, options) => {
    const started = (async () => {
      const client = await globalThis.sliccRequestsClient();
      try {
        return await client.run(['bash', '-c', command], options);
      } finally {
        await client.close();
      }
    })();
    window.runs.push(started);
    return window.runs.length - 1;
  };
};

async function seven(t) {
  const page = await chrome.page(t);
  await page.init(faux);
  await boot(page);
  return page;
}

const started = (page, command) =>
  page.evaluate(({ command, tag }) => window.background(command, { user: 'cone', tag }), {
    command,
    tag: AGENT,
  });

const finished = (page, index) => page.evaluate((index) => window.runs[index], index);

const asCone = async (page, command) => finished(page, await started(page, command));

const hidSwitch = (page, on) =>
  page.evaluate((on) => document.querySelector('slicc-app').model.switches.set('hid', on), on);

test('hid is installed with the base set, a cone in plugdev lists and requests a device typed in a terminal with the chooser opening at once, and an open device shows a chip whose Close closes it, as unplugging does', async (t) => {
  const page = await seven(t);
  await run(page, 'command -v hid; hid --version; echo "version $?"');
  await shows(page, '/usr/bin/hid');
  await shows(page, 'version 0');
  assert.match(await screen(page), new RegExp(`\\b${PINNED.replaceAll('.', '\\.')}\\s+version 0`));

  await run(
    page,
    'sudo -u cone id -nG; sudo -u cone hid list; sudo -u cone hid request --vid 0x320f; echo "typed $?"'
  );
  await shows(page, 'typed 0');
  const typed = await screen(page);
  assert.match(typed, /\bplugdev\b/);
  assert.match(typed, /no granted HID devices/);
  assert.match(typed, /hid1\s+0x320f:0x5044\s+0xff60:0x0061\s+Nano Pad\s+typed 0/);
  assert.deepEqual(await page.evaluate(() => window.hidLog.chooser), [
    { active: true, filters: [{ vendorId: 0x320f }] },
  ]);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  const listed = await asCone(page, 'hid list; echo "listed $?"');
  assert.match(listed.stdout, /hid1\s+0x320f:0x5044\s+0xff60:0x0061\s+Nano Pad/, listed.stderr);
  assert.match(listed.stdout, /listed 0/);

  await run(page, 'hid open hid1; echo "opened $?"');
  await shows(page, 'opened 0');
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /HID device open · hid1 \(0x320f:0x5044 Nano Pad\) · a terminal · \d+:\d\d/);
  await shoot(page, 'hid-live-chip');
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.hidOpen()), false);
  await run(page, 'hid list; echo "after $?"');
  await shows(page, 'after 0');
  assert.match(await screen(page), /Nano Pad\s+after 0/);

  await run(page, 'hid open hid1; echo "again $?"');
  await shows(page, 'again 0');
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() => window.unplug());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.hidLog.closed), 2);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('an agent’s hid request shows one click item, Choose… opens the chooser inside that click, and Cancel refuses with no HID device was chosen', async (t) => {
  const page = await seven(t);
  const chosen = await started(page, 'hid request; echo "agent $?"');
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.subject, 'device');
  assert.equal(item.what, 'hid');
  assert.equal(item.here, true);
  assert.equal(item.title, 'Choose a HID device');
  assert.equal(
    item.body,
    "The agent cone:cone wants to use a HID device. Click Choose, then pick it in the browser's list."
  );
  assert.equal(item.action, 'Choose…');
  assert.equal(item.requester.kind, 'agent');
  assert.equal(item.expiresAt - item.createdAt, 300000);
  assert.deepEqual(await page.evaluate(() => window.hidLog.chooser), []);
  await shoot(page, 'hid-click-item');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  const result = await finished(page, chosen);
  assert.match(result.stdout, /hid1\s+0x320f:0x5044/, result.stderr);
  assert.match(result.stdout, /agent 0/);
  assert.match(result.stderr, /hid: waiting for a click in seven's tab: choose a HID device/);
  assert.deepEqual(await page.evaluate(() => window.hidLog.chooser), [
    { active: true, filters: [] },
  ]);
  await page.until(() => window.clickItems().length === 0);

  const cancelled = await started(page, 'hid request; echo "cancelled $?"');
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="deny"]`);
  const refused = await finished(page, cancelled);
  assert.match(refused.stdout, /cancelled 1/);
  assert.match(refused.stderr, /hid: no HID device was chosen/);
  assert.equal(await page.evaluate(() => window.hidLog.chooser.length), 1);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a cone in plugdev lists and opens a device, its hid send and feature-get are EACCES before the page sees them, and sudo sends and reads feature reports', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grant());
  const reads = await asCone(page, 'id -nG; hid list; hid open hid1; echo "reads $?"');
  assert.match(reads.stdout, /\bplugdev\b/, reads.stderr);
  assert.match(reads.stdout, /hid1\s+0x320f:0x5044.*\nreads 0/, reads.stderr);
  assert.equal(await page.evaluate(() => window.hidLog.opened), 1);

  const writes = await asCone(
    page,
    'printf ab | hid send hid1 0; echo "send $?"; printf ab | hid feature-send hid1 2; echo "feature $?"; hid feature-get hid1 1; echo "get $?"'
  );
  assert.match(writes.stdout, /send 1\nfeature 1\nget 1/);
  assert.match(writes.stderr, /hid: hid\.send is not allowed for this user/);
  assert.match(writes.stderr, /hid: hid\.send-feature is not allowed for this user/);
  assert.match(writes.stderr, /hid: hid\.receive-feature is not allowed for this user/);
  assert.deepEqual(await page.evaluate(() => window.hidLog.sent), []);
  assert.deepEqual(await page.evaluate(() => window.hidLog.features), []);
  assert.deepEqual(await page.evaluate(() => window.hidLog.asked), []);

  await run(
    page,
    'echo \'NOPASSWD cone Cmnd *\' > /etc/sudoers.d/cone-hid && chmod 0440 /etc/sudoers.d/cone-hid; echo "rule $?"'
  );
  await shows(page, 'rule 0');
  const sudo = await asCone(
    page,
    'printf ab | sudo -n hid send hid1 0; printf cd | sudo -n hid feature-send hid1 2; sudo -n hid feature-get hid1 1; echo "sudo $?"'
  );
  assert.match(sudo.stdout, /01 0a 0b\nsudo 0/, sudo.stderr);
  assert.deepEqual(await page.evaluate(() => window.hidLog.sent), [[0, [0x61, 0x62]]]);
  assert.deepEqual(await page.evaluate(() => window.hidLog.features), [[2, [0x63, 0x64]]]);
  assert.deepEqual(await page.evaluate(() => window.hidLog.asked), [1]);
  assert.deepEqual(page.errors, []);
});

test('the HID devices switch sits after USB devices and before Bluetooth and MIDI devices, ends a hid watch and closes every open device when turned off, refuses every hid kind before the chooser, survives a reload, and is in no kernel file', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    (await page.evaluate(() => document.querySelector('slicc-app').model.switches.list())).slice(
      -5
    ),
    [
      { key: 'serial', label: 'Serial ports', on: true },
      { key: 'usb', label: 'USB devices', on: true },
      { key: 'hid', label: 'HID devices', on: true },
      { key: 'ble', label: 'Bluetooth devices', on: true },
      { key: 'midi', label: 'MIDI devices', on: true },
    ]
  );
  await page.evaluate(() => window.grant());
  const opened = await asCone(page, 'hid open hid1; echo "cone $?"');
  assert.match(opened.stdout, /cone 0/, opened.stderr);
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /HID device open · hid1 \(0x320f:0x5044 Nano Pad\) · cone · \d+:\d\d/);
  await run(page, 'hid watch hid1; echo "watch $?"');
  await page.until(() => window.hidListening() === 1);
  await page.evaluate(() => window.report(1, [0x6f, 0x6b]));
  await shows(page, '01 6f 6b');
  await hidSwitch(page, false);
  await shows(page, 'watch 1');
  assert.match(
    await screen(page),
    /01 6f 6b\s+hid: HID devices are off in seven's settings\s+watch 1/
  );
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.hidLog.closed), 1);
  assert.equal(await page.evaluate(() => window.hidOpen()), false);
  assert.equal(await page.evaluate(() => window.hidListening()), 0);

  await run(
    page,
    'hid list; echo "list off $?"; hid request; echo "request off $?"; hid open hid1; echo "open off $?"; hid watch hid1; echo "watch off $?"; printf x | hid send hid1 0; echo "send off $?"; hid feature-get hid1 1; echo "get off $?"'
  );
  await shows(page, 'get off 1');
  const off = await screen(page);
  for (const name of ['list', 'request', 'open', 'watch', 'send', 'get'])
    assert.match(off, new RegExp(`hid: HID devices are off in seven's settings\\s+${name} off 1`));
  const agent = await asCone(page, 'hid request; echo "agent off $?"');
  assert.match(agent.stdout, /agent off 1/);
  assert.match(agent.stderr, /HID devices are off in seven's settings/);
  assert.deepEqual(await page.evaluate(() => window.hidLog.chooser), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.hidLog.opened), 1);
  assert.deepEqual(await page.evaluate(() => window.hidLog.sent), []);

  await run(
    page,
    'grep -rlsF slicc-os.switches /etc /home /root /tmp /var 2>/dev/null; echo "kernel files checked"'
  );
  await shows(page, 'kernel files checked');
  assert.doesNotMatch(
    (await screen(page)).replace(/grep -rlsF slicc-os\.switches/, ''),
    /slicc-os\.switches/
  );

  await page.reload();
  await ready(page);
  assert.deepEqual(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.switches.list()
        .filter(({ key }) => ['serial', 'usb', 'hid'].includes(key))
    ),
    [
      { key: 'serial', label: 'Serial ports', on: true },
      { key: 'usb', label: 'USB devices', on: true },
      { key: 'hid', label: 'HID devices', on: false },
    ]
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.deep('[data-surface="switches"] [data-id="hid"]'));
  await shoot(page, 'hid-switch');
  await run(page, 'hid list; echo "still off $?"');
  await shows(page, 'still off 1');
  await hidSwitch(page, true);
  await run(page, 'hid list; echo "back on $?"');
  await shows(page, 'back on 0');
  assert.deepEqual(page.errors, []);
});

test('turning HID devices off while a hid open is still in flight closes the device again and refuses the open with no chip, and after turning it back on the device is listed closed and opens afresh', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grant());
  await page.evaluate(() => window.hold('open'));
  await run(page, 'hid open hid1; echo "pending $?"');
  await page.until(() => window.hidLog.held.includes('open'));
  await hidSwitch(page, false);
  await page.evaluate(() => window.release('open'));
  await shows(page, 'pending 1');
  assert.match(await screen(page), /hid: HID devices are off in seven's settings\s+pending 1/);
  await page.until(() => window.hidLog.closed === 1);
  assert.equal(await page.evaluate(() => window.hidLog.opened), 1);
  assert.equal(await page.evaluate(() => window.hidOpen()), false);
  assert.equal(await page.evaluate(() => window.hidListening()), 0);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);

  await hidSwitch(page, true);
  await run(page, 'hid list; echo "listed $?"; hid open hid1; echo "fresh $?"');
  await shows(page, 'fresh 0');
  const shown = await screen(page);
  assert.match(shown, /hid1\s+0x320f:0x5044\s+0xff60:0x0061\s+Nano Pad\s+listed 0/);
  assert.doesNotMatch(shown, /\[open\]/);
  await page.until(() => window.chips().length === 1);
  assert.equal(await page.evaluate(() => window.hidLog.opened), 2);
  assert.deepEqual(page.errors, []);
});

test('turning HID devices off while an agent’s hid request waits on the click, or while the chooser is open, refuses the request with nothing opened and no chip, and the device the browser granted is listed closed once it is back on', async (t) => {
  const page = await seven(t);
  const clicked = await started(page, 'hid request; echo "click off $?"');
  await page.until(() => window.clickItems().length === 1);
  await hidSwitch(page, false);
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  const refused = await finished(page, clicked);
  assert.match(refused.stdout, /click off 1/);
  assert.match(refused.stderr, /hid: HID devices are off in seven's settings/);
  assert.deepEqual(await page.evaluate(() => window.hidLog.chooser), []);

  await hidSwitch(page, true);
  await page.evaluate(() => window.hold('chooser'));
  const choosing = await started(page, 'hid request; echo "chooser off $?"');
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await page.until(() => window.hidLog.held.includes('chooser'));
  await hidSwitch(page, false);
  await page.evaluate(() => window.release('chooser'));
  const late = await finished(page, choosing);
  assert.match(late.stdout, /chooser off 1/);
  assert.match(late.stderr, /hid: HID devices are off in seven's settings/);
  assert.doesNotMatch(late.stdout, /hid1\s+0x320f/);
  assert.deepEqual(await page.evaluate(() => window.hidLog.chooser), [
    { active: true, filters: [] },
  ]);
  assert.equal(await page.evaluate(() => window.hidLog.opened), 0);

  await hidSwitch(page, true);
  const after = await asCone(page, 'hid list; echo "listed $?"');
  assert.match(after.stdout, /^hid1\s+0x320f:0x5044\s+0xff60:0x0061\s+Nano Pad$/m, after.stderr);
  assert.doesNotMatch(after.stdout, /\[open\]/);
  assert.match(after.stdout, /listed 0/);
  assert.equal(await page.evaluate(() => window.hidOpen()), false);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);
  assert.deepEqual(page.errors, []);
});
