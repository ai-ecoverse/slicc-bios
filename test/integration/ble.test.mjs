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
const HEART_RATE = '0000180d-0000-1000-8000-00805f9b34fb';

const faux = () => {
  globalThis.sliccKernelDebug = true;
  const uuid = (short) => `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
  window.bleLog = {
    chooser: [],
    connects: 0,
    disconnects: 0,
    reads: 0,
    writes: [],
    started: 0,
    stopped: 0,
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
    window.bleLog.held.push(what);
    await held.gate;
  };
  class FakeCharacteristic extends EventTarget {
    constructor(service, short, properties, bytes) {
      super();
      this.service = service;
      this.uuid = uuid(short);
      this.properties = properties;
      this.value = new DataView(Uint8Array.from(bytes).buffer);
      this.notifying = false;
    }
    async getDescriptors() {
      return [];
    }
    async readValue() {
      window.bleLog.reads += 1;
      return this.value;
    }
    async writeValueWithResponse(data) {
      window.bleLog.writes.push([this.uuid, [...new Uint8Array(data)]]);
    }
    async writeValueWithoutResponse(data) {
      window.bleLog.writes.push([this.uuid, [...new Uint8Array(data)], 'no response']);
    }
    async startNotifications() {
      this.notifying = true;
      window.bleLog.started += 1;
      return this;
    }
    async stopNotifications() {
      this.notifying = false;
      window.bleLog.stopped += 1;
      return this;
    }
  }
  class FakeService {
    constructor(device) {
      this.device = device;
      this.uuid = uuid(0x180d);
      this.isPrimary = true;
      this.characteristics = [
        new FakeCharacteristic(this, 0x2a37, { notify: true }, [0x00, 0x3c]),
        new FakeCharacteristic(this, 0x2a38, { read: true, write: true }, [0x01]),
      ];
    }
    async getCharacteristic(wanted) {
      const found = this.characteristics.find((each) => each.uuid === wanted);
      if (!found)
        throw new DOMException('No Characteristics matching UUID found.', 'NotFoundError');
      return found;
    }
    async getCharacteristics() {
      return [...this.characteristics];
    }
  }
  const device = new EventTarget();
  device.id = 'polar-h10-id';
  device.name = 'Polar H10';
  const service = new FakeService(device);
  device.gatt = {
    device,
    connected: false,
    async connect() {
      await passed('connect');
      this.connected = true;
      window.bleLog.connects += 1;
      return this;
    },
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      window.bleLog.disconnects += 1;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    async getPrimaryService(wanted) {
      if (!this.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
      if (wanted !== service.uuid)
        throw new DOMException('No Services matching UUID found.', 'NotFoundError');
      return service;
    },
    async getPrimaryServices() {
      if (!this.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
      return [service];
    },
  };
  const granted = [];
  const bluetooth = new EventTarget();
  bluetooth.getAvailability = async () => true;
  bluetooth.getDevices = async () => [...granted];
  bluetooth.requestDevice = async (options = {}) => {
    const active = navigator.userActivation.isActive;
    window.bleLog.chooser.push({ active, options });
    if (!active)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    await passed('chooser');
    if (!granted.includes(device)) granted.push(device);
    return device;
  };
  Object.defineProperty(Navigator.prototype, 'bluetooth', {
    configurable: true,
    get: () => bluetooth,
  });
  window.grant = () => {
    if (!granted.includes(device)) granted.push(device);
  };
  window.drop = () => device.gatt.disconnect();
  window.beat = (bytes) => {
    const [measurement] = service.characteristics;
    measurement.value = new DataView(Uint8Array.from(bytes).buffer);
    measurement.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  window.bleConnected = () => device.gatt.connected;
  window.bleNotifying = () => service.characteristics[0].notifying;
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

const bleSwitch = (page, on) =>
  page.evaluate((on) => document.querySelector('slicc-app').model.switches.set('ble', on), on);

test('ble is installed with the base set, a cone in bluetooth lists and requests a device typed in a terminal with the chooser opening at once, and a connected device shows a chip whose Close disconnects it, as the device going away does', async (t) => {
  const page = await seven(t);
  await run(page, 'command -v ble; ble --version; echo "version $?"');
  await shows(page, '/usr/bin/ble');
  await shows(page, 'version 0');
  assert.match(await screen(page), new RegExp(`\\b${PINNED.replaceAll('.', '\\.')}\\s+version 0`));

  await run(
    page,
    'sudo -u cone id -nG; sudo -u cone ble list; sudo -u cone ble request --service heart_rate; echo "typed $?"'
  );
  await shows(page, 'typed 0');
  const typed = await screen(page);
  assert.match(typed, /\bbluetooth\b/);
  assert.match(typed, /no Bluetooth devices/);
  assert.match(typed, /ble1 {2}Polar H10\s+typed 0/);
  assert.deepEqual(await page.evaluate(() => window.bleLog.chooser), [
    {
      active: true,
      options: { filters: [{ services: [HEART_RATE] }], optionalServices: [HEART_RATE] },
    },
  ]);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  const listed = await asCone(page, 'ble list; echo "listed $?"');
  assert.match(listed.stdout, /^ble1 {2}Polar H10$/m, listed.stderr);
  assert.match(listed.stdout, /listed 0/);

  await run(page, 'ble connect ble1; echo "connected $?"');
  await shows(page, 'connected 0');
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /Bluetooth device connected · ble1 \(Polar H10\) · a terminal · \d+:\d\d/);
  await shoot(page, 'ble-live-chip');
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.bleConnected()), false);
  await run(page, 'ble list; echo "after $?"');
  await shows(page, 'after 0');
  assert.match(await screen(page), /ble1 {2}Polar H10\s+after 0/);

  await run(page, 'ble connect ble1; echo "again $?"');
  await shows(page, 'again 0');
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() => window.drop());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.bleLog.connects), 2);
  assert.equal(await page.evaluate(() => window.bleLog.disconnects), 2);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('an agent’s ble request shows one click item, Choose… opens the chooser inside that click, and Cancel refuses with no Bluetooth device was chosen', async (t) => {
  const page = await seven(t);
  const chosen = await started(page, 'ble request --all; echo "agent $?"');
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.subject, 'device');
  assert.equal(item.what, 'ble');
  assert.equal(item.here, true);
  assert.equal(item.title, 'Choose a Bluetooth device');
  assert.equal(
    item.body,
    "The agent cone:cone wants to use a Bluetooth device. Click Choose, then pick it in the browser's list."
  );
  assert.equal(item.action, 'Choose…');
  assert.equal(item.requester.kind, 'agent');
  assert.equal(item.expiresAt - item.createdAt, 300000);
  assert.deepEqual(await page.evaluate(() => window.bleLog.chooser), []);
  await shoot(page, 'ble-click-item');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  const result = await finished(page, chosen);
  assert.match(result.stdout, /ble1 {2}Polar H10/, result.stderr);
  assert.match(result.stdout, /agent 0/);
  assert.match(result.stderr, /ble: waiting for a click in seven's tab: choose a Bluetooth device/);
  assert.deepEqual(await page.evaluate(() => window.bleLog.chooser), [
    { active: true, options: { acceptAllDevices: true } },
  ]);
  await page.until(() => window.clickItems().length === 0);

  const cancelled = await started(page, 'ble request --all; echo "cancelled $?"');
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="deny"]`);
  const refused = await finished(page, cancelled);
  assert.match(refused.stdout, /cancelled 1/);
  assert.match(refused.stderr, /ble: no Bluetooth device was chosen/);
  assert.equal(await page.evaluate(() => window.bleLog.chooser.length), 1);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a cone in bluetooth lists, connects, reads services and a characteristic, its ble write is EACCES before the page sees it, and sudo ble write works', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grant());
  const reads = await asCone(
    page,
    'id -nG; ble list; ble connect ble1; ble services ble1; ble read ble1 heart_rate body_sensor_location; echo "reads $?"'
  );
  assert.match(reads.stdout, /\bbluetooth\b/, reads.stderr);
  assert.match(reads.stdout, /^ble1 {2}Polar H10$/m, reads.stderr);
  assert.match(reads.stdout, /"uuid":"0000180d-0000-1000-8000-00805f9b34fb"/, reads.stderr);
  assert.match(reads.stdout, /\n01\nreads 0/, reads.stderr);
  assert.equal(await page.evaluate(() => window.bleLog.connects), 1);
  assert.equal(await page.evaluate(() => window.bleLog.reads), 1);

  const writes = await asCone(
    page,
    'printf \'\\002\' | ble write ble1 heart_rate body_sensor_location; echo "write $?"'
  );
  assert.match(writes.stdout, /write 1/);
  assert.match(writes.stderr, /ble: ble\.write is not allowed for this user/);
  assert.deepEqual(await page.evaluate(() => window.bleLog.writes), []);

  await run(
    page,
    'echo \'NOPASSWD cone Cmnd *\' > /etc/sudoers.d/cone-ble && chmod 0440 /etc/sudoers.d/cone-ble; echo "rule $?"'
  );
  await shows(page, 'rule 0');
  const sudo = await asCone(
    page,
    'printf \'\\002\' | sudo -n ble write ble1 heart_rate body_sensor_location; echo "sudo $?"'
  );
  assert.match(sudo.stdout, /sudo 0/, sudo.stderr);
  assert.deepEqual(await page.evaluate(() => window.bleLog.writes), [
    ['00002a38-0000-1000-8000-00805f9b34fb', [0x02]],
  ]);
  assert.deepEqual(page.errors, []);
});

test('the Bluetooth devices switch sits after HID devices and before MIDI devices, ends a ble notify and disconnects every device when turned off, refuses every ble kind before the chooser, survives a reload, and is in no kernel file', async (t) => {
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
  const connected = await asCone(page, 'ble connect ble1; echo "cone $?"');
  assert.match(connected.stdout, /cone 0/, connected.stderr);
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /Bluetooth device connected · ble1 \(Polar H10\) · cone · \d+:\d\d/);
  await run(page, 'ble notify ble1 heart_rate heart_rate_measurement; echo "notify $?"');
  await page.until(() => window.bleNotifying());
  await page.evaluate(() => window.beat([0x06, 0x48]));
  await shows(page, '06 48');
  await bleSwitch(page, false);
  await shows(page, 'notify 1');
  assert.match(
    await screen(page),
    /06 48\s+ble: Bluetooth devices are off in seven's settings\s+notify 1/
  );
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.bleConnected()), false);
  assert.equal(await page.evaluate(() => window.bleNotifying()), false);
  assert.equal(await page.evaluate(() => window.bleLog.disconnects), 1);

  await run(
    page,
    'ble list; echo "list off $?"; ble request --all; echo "request off $?"; ble connect ble1; echo "connect off $?"; ble services ble1; echo "services off $?"; ble read ble1 heart_rate body_sensor_location; echo "read off $?"; ble notify ble1 heart_rate heart_rate_measurement; echo "notify off $?"; printf x | ble write ble1 heart_rate body_sensor_location; echo "write off $?"; ble disconnect ble1; echo "disconnect off $?"'
  );
  await shows(page, 'disconnect off 1');
  const off = await screen(page);
  for (const name of [
    'list',
    'request',
    'connect',
    'services',
    'read',
    'notify',
    'write',
    'disconnect',
  ])
    assert.match(
      off,
      new RegExp(`ble: Bluetooth devices are off in seven's settings\\s+${name} off 1`)
    );
  const agent = await asCone(page, 'ble request --all; echo "agent off $?"');
  assert.match(agent.stdout, /agent off 1/);
  assert.match(agent.stderr, /Bluetooth devices are off in seven's settings/);
  assert.deepEqual(await page.evaluate(() => window.bleLog.chooser), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.bleLog.connects), 1);
  assert.equal(await page.evaluate(() => window.bleLog.reads), 0);
  assert.deepEqual(await page.evaluate(() => window.bleLog.writes), []);

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
        .filter(({ key }) => ['serial', 'usb', 'hid', 'ble'].includes(key))
    ),
    [
      { key: 'serial', label: 'Serial ports', on: true },
      { key: 'usb', label: 'USB devices', on: true },
      { key: 'hid', label: 'HID devices', on: true },
      { key: 'ble', label: 'Bluetooth devices', on: false },
    ]
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.deep('[data-surface="switches"] [data-id="ble"]'));
  await shoot(page, 'ble-switch');
  await run(page, 'ble list; echo "still off $?"');
  await shows(page, 'still off 1');
  await bleSwitch(page, true);
  await run(page, 'ble list; echo "back on $?"');
  await shows(page, 'back on 0');
  assert.deepEqual(page.errors, []);
});

test('turning Bluetooth devices off while a ble connect is still in flight disconnects the device again and refuses the connect with no chip, and after turning it back on the device connects afresh', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grant());
  await page.evaluate(() => window.hold('connect'));
  await run(page, 'ble connect ble1; echo "pending $?"');
  await page.until(() => window.bleLog.held.includes('connect'));
  await bleSwitch(page, false);
  await page.evaluate(() => window.release('connect'));
  await shows(page, 'pending 1');
  assert.match(
    await screen(page),
    /ble: Bluetooth devices are off in seven's settings\s+pending 1/
  );
  await page.until(() => window.bleLog.disconnects === 1);
  assert.equal(await page.evaluate(() => window.bleLog.connects), 1);
  assert.equal(await page.evaluate(() => window.bleConnected()), false);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);

  await bleSwitch(page, true);
  await run(page, 'ble list; echo "listed $?"; ble connect ble1; echo "fresh $?"');
  await shows(page, 'fresh 0');
  const shown = await screen(page);
  assert.match(shown, /ble1 {2}Polar H10\s+listed 0/);
  await page.until(() => window.chips().length === 1);
  assert.equal(await page.evaluate(() => window.bleLog.connects), 2);
  assert.equal(await page.evaluate(() => window.bleConnected()), true);
  assert.deepEqual(page.errors, []);
});

test('turning Bluetooth devices off while an agent’s ble request waits on the click, or while the chooser is open, refuses the request with nothing connected and no chip, and the device the browser granted is listed once it is back on', async (t) => {
  const page = await seven(t);
  const clicked = await started(page, 'ble request --all; echo "click off $?"');
  await page.until(() => window.clickItems().length === 1);
  await bleSwitch(page, false);
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  const refused = await finished(page, clicked);
  assert.match(refused.stdout, /click off 1/);
  assert.match(refused.stderr, /ble: Bluetooth devices are off in seven's settings/);
  assert.deepEqual(await page.evaluate(() => window.bleLog.chooser), []);

  await bleSwitch(page, true);
  await page.evaluate(() => window.hold('chooser'));
  const choosing = await started(page, 'ble request --all; echo "chooser off $?"');
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await page.until(() => window.bleLog.held.includes('chooser'));
  await bleSwitch(page, false);
  await page.evaluate(() => window.release('chooser'));
  const late = await finished(page, choosing);
  assert.match(late.stdout, /chooser off 1/);
  assert.match(late.stderr, /ble: Bluetooth devices are off in seven's settings/);
  assert.doesNotMatch(late.stdout, /Polar H10/);
  assert.deepEqual(await page.evaluate(() => window.bleLog.chooser), [
    { active: true, options: { acceptAllDevices: true } },
  ]);
  assert.equal(await page.evaluate(() => window.bleLog.connects), 0);

  await bleSwitch(page, true);
  const after = await asCone(page, 'ble list; echo "listed $?"');
  assert.match(after.stdout, /^ble1 {2}Polar H10$/m, after.stderr);
  assert.match(after.stdout, /listed 0/);
  assert.equal(await page.evaluate(() => window.bleConnected()), false);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);
  assert.deepEqual(page.errors, []);
});

test('a boot on an /etc/group without bluetooth adds it with gid 110 and puts every cone and scoop in it, and a scoop the agent adds joins it too', async (t) => {
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
  assert.ok(scoop.groups.includes(110), JSON.stringify(scoop));
  assert.ok(!scoop.groups.includes(27), JSON.stringify(scoop));
  await page.evaluate(() =>
    globalThis.sliccAgentSource().users.add({ name: 'cone-2', groups: [] })
  );
  await run(
    page,
    "grep -v '^bluetooth:' /etc/group > /tmp/group && cat /tmp/group > /etc/group; grep -c '^bluetooth:' /etc/group; echo \"gone $?\""
  );
  await shows(page, 'gone 1');

  await page.reload();
  await ready(page);
  const bluetooth = await page.evaluate(async () =>
    (await globalThis.sliccAgentSource().groups.list()).find((group) => group.name === 'bluetooth')
  );
  assert.equal(bluetooth?.gid, 110, JSON.stringify(bluetooth));
  assert.deepEqual([...bluetooth.members].sort(), ['cone', 'cone-2', 'scoop-site']);
  const ids = await asCone(page, 'id -nG');
  assert.match(ids.stdout, /\bbluetooth\b/);
  const scoopIds = await page.evaluate(async () => {
    const client = await globalThis.sliccRequestsClient();
    try {
      return await client.run(['bash', '-c', 'id -nG'], {
        user: 'scoop-site',
        tag: '{"kind":"agent","agentId":"scoop:site"}',
      });
    } finally {
      await client.close();
    }
  });
  assert.match(scoopIds.stdout, /\bbluetooth\b/, scoopIds.stderr);
  assert.doesNotMatch(scoopIds.stdout, /\bsudo\b/);
  await assert.rejects(
    page.evaluate(() => globalThis.sliccAgentSource().groups.addMember('bluetooth', 'scoop-site')),
    /bios refuses the group bluetooth/
  );
  assert.deepEqual(page.errors, []);
});
