import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows } from './bios.mjs';
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
  window.usbLog = { chooser: [], opened: 0, closed: 0, claimed: [], out: [], control: [] };
  class FakeDevice {
    constructor() {
      this.vendorId = 0x2341;
      this.productId = 0x0043;
      this.manufacturerName = 'Arduino LLC';
      this.productName = 'Arduino Uno';
      this.serialNumber = 'UNO1';
      this.deviceClass = 2;
      this.opened = false;
      this.queue = [];
      const alternate = {
        alternateSetting: 0,
        interfaceClass: 0xff,
        interfaceSubclass: 0,
        interfaceProtocol: 0,
        endpoints: [
          { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
          { endpointNumber: 2, direction: 'in', type: 'bulk', packetSize: 64 },
        ],
      };
      this.iface = { interfaceNumber: 0, alternate, alternates: [alternate], claimed: false };
      this.configuration = { configurationValue: 1, interfaces: [this.iface] };
      this.configurations = [this.configuration];
    }
    async open() {
      if (this.opened) throw new DOMException('The device is already open.', 'InvalidStateError');
      this.opened = true;
      window.usbLog.opened += 1;
    }
    async close() {
      this.opened = false;
      this.iface.claimed = false;
      window.usbLog.closed += 1;
    }
    async selectConfiguration() {}
    async reset() {}
    async clearHalt() {}
    async claimInterface(number) {
      this.iface.claimed = true;
      window.usbLog.claimed.push(number);
    }
    async releaseInterface() {
      this.iface.claimed = false;
    }
    async transferOut(endpoint, data) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength).slice();
      window.usbLog.out.push([endpoint, [...bytes]]);
      this.queue.push(bytes);
      return { status: 'ok', bytesWritten: bytes.byteLength };
    }
    async transferIn(_endpoint, length) {
      const next = this.queue.shift() ?? Uint8Array.from([0x6f, 0x6b]);
      return {
        status: 'ok',
        data: new DataView(next.buffer, 0, Math.min(length, next.byteLength)),
      };
    }
    async controlTransferIn(setup) {
      window.usbLog.control.push(setup);
      return { status: 'ok', data: new DataView(Uint8Array.from([1, 2, 3]).buffer) };
    }
    async controlTransferOut(setup, data) {
      window.usbLog.control.push(setup);
      return { status: 'ok', bytesWritten: data.byteLength };
    }
  }
  const device = new FakeDevice();
  const granted = [];
  const usb = new EventTarget();
  usb.getDevices = async () => [...granted];
  usb.requestDevice = async ({ filters } = {}) => {
    const active = navigator.userActivation.isActive;
    window.usbLog.chooser.push({ active, filters });
    if (!active)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    if (!granted.includes(device)) granted.push(device);
    return device;
  };
  Object.defineProperty(Navigator.prototype, 'usb', { configurable: true, get: () => usb });
  window.grant = () => {
    if (!granted.includes(device)) granted.push(device);
  };
  window.unplug = () => {
    granted.splice(granted.indexOf(device), 1);
    const event = new Event('disconnect');
    Object.defineProperty(event, 'device', { value: device });
    usb.dispatchEvent(event);
  };
  window.usbOpen = () => device.opened;
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

const asCone = (page, command) =>
  page.evaluate(
    ({ command, tag }) => window.runs[window.background(command, { user: 'cone', tag })],
    { command, tag: AGENT }
  );

const started = (page, command) =>
  page.evaluate(({ command, tag }) => window.background(command, { user: 'cone', tag }), {
    command,
    tag: AGENT,
  });

const finished = (page, index) => page.evaluate((index) => window.runs[index], index);

const usbSwitch = (page, on) =>
  page.evaluate((on) => document.querySelector('slicc-app').model.switches.set('usb', on), on);

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

test('usb is installed with the base set, a cone in plugdev lists and requests a device typed in a terminal with the chooser opening at once, and an open device shows a chip whose Close closes it, as unplugging does', async (t) => {
  const page = await seven(t);
  await run(page, 'command -v usb; usb --version; echo "version $?"');
  await shows(page, '/usr/bin/usb');
  await shows(page, 'version 0');
  assert.match(await screen(page), new RegExp(`\\b${PINNED.replaceAll('.', '\\.')}\\s+version 0`));

  await run(
    page,
    'sudo -u cone id -nG; sudo -u cone usb list; sudo -u cone usb request --vid 0x2341; echo "typed $?"'
  );
  await shows(page, 'typed 0');
  const typed = await screen(page);
  assert.match(typed, /\bplugdev\b/);
  assert.match(typed, /no granted USB devices/);
  assert.match(typed, /usb1\s+0x2341:0x0043\s+Arduino LLC Arduino Uno serial=UNO1\s+typed 0/);
  assert.deepEqual(await page.evaluate(() => window.usbLog.chooser), [
    { active: true, filters: [{ vendorId: 0x2341 }] },
  ]);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  const listed = await asCone(page, 'usb list; echo "listed $?"');
  assert.match(listed.stdout, /usb1\s+0x2341:0x0043\s+Arduino LLC Arduino Uno/, listed.stderr);
  assert.match(listed.stdout, /listed 0/);

  await run(page, 'usb open usb1; echo "opened $?"');
  await shows(page, 'opened 0');
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(
    chip,
    /USB device open · usb1 \(0x2341:0x0043 Arduino Uno\) · a terminal · \d+:\d\d/
  );
  await shoot(page, 'usb-live-chip');
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.usbOpen()), false);
  await run(page, 'usb transfer-in usb1 2 8; echo "after $?"');
  await shows(page, 'usb: usb1 was closed in seven');
  await shows(page, 'after 1');

  await run(page, 'usb open usb1; echo "again $?"');
  await shows(page, 'again 0');
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() => window.unplug());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.usbLog.closed), 2);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('an agent’s usb request shows one click item, Choose… opens the chooser inside that click, and Cancel refuses with no USB device was chosen', async (t) => {
  const page = await seven(t);
  const chosen = await started(page, 'usb request; echo "agent $?"');
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.subject, 'device');
  assert.equal(item.what, 'usb');
  assert.equal(item.here, true);
  assert.equal(item.title, 'Choose a USB device');
  assert.equal(
    item.body,
    "The agent cone:cone wants to use a USB device. Click Choose, then pick it in the browser's list."
  );
  assert.equal(item.action, 'Choose…');
  assert.equal(item.requester.kind, 'agent');
  assert.equal(item.expiresAt - item.createdAt, 300000);
  assert.deepEqual(await page.evaluate(() => window.usbLog.chooser), []);
  await shoot(page, 'usb-click-item');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  const result = await finished(page, chosen);
  assert.match(result.stdout, /usb1\s+0x2341:0x0043/, result.stderr);
  assert.match(result.stdout, /agent 0/);
  assert.match(result.stderr, /usb: waiting for a click in seven's tab: choose a USB device/);
  assert.deepEqual(await page.evaluate(() => window.usbLog.chooser), [
    { active: true, filters: [] },
  ]);
  await page.until(() => window.clickItems().length === 0);

  const cancelled = await started(page, 'usb request; echo "cancelled $?"');
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="deny"]`);
  const refused = await finished(page, cancelled);
  assert.match(refused.stdout, /cancelled 1/);
  assert.match(refused.stderr, /usb: no USB device was chosen/);
  assert.equal(await page.evaluate(() => window.usbLog.chooser.length), 1);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a cone in plugdev opens, claims and reads a device, its transfer-out and control-in are EACCES before the page sees them, and sudo usb transfer-out acts on the cone’s own claim', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grant());
  const reads = await asCone(
    page,
    'id -nG; usb open usb1; usb claim usb1 0; usb transfer-in usb1 2 8; echo "reads $?"'
  );
  assert.match(reads.stdout, /\bplugdev\b/, reads.stderr);
  assert.match(reads.stdout, /6f 6b\nreads 0/, reads.stderr);
  assert.deepEqual(await page.evaluate(() => window.usbLog.claimed), [0]);

  const writes = await asCone(
    page,
    'printf ab | usb transfer-out usb1 1; echo "out $?"; usb control-in usb1 3 --request 1; echo "control $?"'
  );
  assert.match(writes.stdout, /out 1/);
  assert.match(writes.stdout, /control 1/);
  assert.match(writes.stderr, /usb: usb\.transfer\.out is not allowed for this user/);
  assert.match(writes.stderr, /usb: usb\.control is not allowed for this user/);
  assert.deepEqual(await page.evaluate(() => window.usbLog.out), []);
  assert.deepEqual(await page.evaluate(() => window.usbLog.control), []);

  await run(page, 'printf x | usb transfer-out usb1 1; echo "root $?"');
  await shows(page, 'root 1');
  assert.match(await screen(page), /usb: usb1 is claimed by agent:cone:cone/);

  await run(
    page,
    'echo \'NOPASSWD cone Cmnd *\' > /etc/sudoers.d/cone-usb && chmod 0440 /etc/sudoers.d/cone-usb; echo "rule $?"'
  );
  await shows(page, 'rule 0');
  const sudo = await asCone(
    page,
    'printf ab | sudo -n usb transfer-out usb1 1; sudo -n usb control-in usb1 3 --request 1; usb transfer-in usb1 2 8; echo "sudo $?"'
  );
  assert.match(sudo.stdout, /2 bytes written\n01 02 03\n61 62\nsudo 0/, sudo.stderr);
  assert.deepEqual(await page.evaluate(() => window.usbLog.out), [[1, [0x61, 0x62]]]);
  assert.equal(await page.evaluate(() => window.usbLog.control.length), 1);
  assert.deepEqual(page.errors, []);
});

test('the USB devices switch sits after Serial ports, closes every open device when turned off, refuses every usb kind before the chooser, survives a reload, and is in no kernel file', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    (await page.evaluate(() => document.querySelector('slicc-app').model.switches.list())).slice(
      -2
    ),
    [
      { key: 'serial', label: 'Serial ports', on: true },
      { key: 'usb', label: 'USB devices', on: true },
    ]
  );
  await page.evaluate(() => window.grant());
  await run(page, 'usb open usb1; echo "opened $?"');
  await shows(page, 'opened 0');
  await page.until(() => window.chips().length === 1);
  await usbSwitch(page, false);
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.usbLog.closed), 1);
  assert.equal(await page.evaluate(() => window.usbOpen()), false);

  await run(
    page,
    'usb list; echo "list off $?"; usb request; echo "request off $?"; usb open usb1; echo "open off $?"; usb control-in usb1 1; echo "control off $?"; printf x | usb transfer-out usb1 1; echo "out off $?"'
  );
  await shows(page, 'out off 1');
  const off = await screen(page);
  for (const name of ['list', 'request', 'open', 'control', 'out'])
    assert.match(off, new RegExp(`usb: USB devices are off in seven's settings\\s+${name} off 1`));
  const agent = await asCone(page, 'usb request; echo "agent off $?"');
  assert.match(agent.stdout, /agent off 1/);
  assert.match(agent.stderr, /USB devices are off in seven's settings/);
  assert.deepEqual(await page.evaluate(() => window.usbLog.chooser), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.usbLog.opened), 1);

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
        .filter(({ key }) => key === 'serial' || key === 'usb')
    ),
    [
      { key: 'serial', label: 'Serial ports', on: true },
      { key: 'usb', label: 'USB devices', on: false },
    ]
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.deep('[data-surface="switches"] [data-id="usb"]'));
  await shoot(page, 'usb-switch');
  await run(page, 'usb list; echo "still off $?"');
  await shows(page, 'still off 1');
  await usbSwitch(page, true);
  await run(page, 'usb list; echo "back on $?"');
  await shows(page, 'back on 0');
  assert.deepEqual(page.errors, []);
});

test('a boot on an /etc/group without plugdev adds it with gid 46 and puts every cone and scoop in it, and a scoop the agent adds joins it too', async (t) => {
  const page = await seven(t);
  const scoop = await page.evaluate(() =>
    globalThis.sliccAgentSource().users.add({
      name: 'scoop-site',
      groups: ['cone'],
      homeGroup: 'cone',
      homeMode: 0o2750,
      umask: 0o027,
    })
  );
  assert.ok(scoop.groups.includes(46), JSON.stringify(scoop));
  assert.ok(!scoop.groups.includes(27), JSON.stringify(scoop));
  await page.evaluate(() =>
    globalThis.sliccAgentSource().users.add({ name: 'cone-2', groups: [] })
  );
  await run(
    page,
    "grep -v '^plugdev:' /etc/group > /tmp/group && cat /tmp/group > /etc/group; grep -c '^plugdev:' /etc/group; echo \"gone $?\""
  );
  await shows(page, 'gone 1');

  await page.reload();
  await ready(page);
  const plugdev = await page.evaluate(async () =>
    (await globalThis.sliccAgentSource().groups.list()).find((group) => group.name === 'plugdev')
  );
  assert.equal(plugdev?.gid, 46, JSON.stringify(plugdev));
  assert.deepEqual([...plugdev.members].sort(), ['cone', 'cone-2', 'scoop-site']);
  const ids = await asCone(page, 'id -nG');
  assert.match(ids.stdout, /\bplugdev\b/);
  await assert.rejects(
    page.evaluate(() => globalThis.sliccAgentSource().groups.addMember('plugdev', 'scoop-site')),
    /bios refuses the group plugdev/
  );
  assert.deepEqual(page.errors, []);
});
