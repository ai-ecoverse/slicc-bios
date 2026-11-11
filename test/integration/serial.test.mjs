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
  const ids = { usbVendorId: 0x2e8a, usbProductId: 0x0005 };
  const granted = [];
  window.serialLog = { chooser: [], opened: [], closed: 0, set: [], held: [] };
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
    window.serialLog.held.push(what);
    await held.gate;
  };
  class FakeRom {
    constructor(port) {
      this.port = port;
      this.mode = 'rom';
      this.packet = null;
      this.escaped = false;
      this.queue = Promise.resolve();
      this.seen = [];
      this.registers = new Map([
        [0x40001000, 0x00f01d83],
        [0x3ff5a004, 0xc4123456],
        [0x3ff5a008, 0x240a],
        [0x3ff5a00c, 1 << 15],
        [0x3ff5a014, 1 << 20],
        [0x3ff6607c, 0x80000000],
        [0x3ff40014, 347],
        [0x3ff42080, 0x164020],
      ]);
    }
    signal(signals) {
      if (signals.requestToSend === true) this.mode = 'rom';
    }
    receive(bytes) {
      for (const byte of bytes) {
        if (this.packet === null) {
          if (byte === 0xc0) this.packet = [];
        } else if (this.escaped) {
          this.escaped = false;
          this.packet.push(byte === 0xdc ? 0xc0 : 0xdb);
        } else if (byte === 0xdb) this.escaped = true;
        else if (byte !== 0xc0) this.packet.push(byte);
        else if (this.packet.length) {
          const done = Uint8Array.from(this.packet);
          this.packet = null;
          this.queue = this.queue.then(() => this.handle(done));
        }
      }
    }
    send(bytes) {
      const out = [0xc0];
      for (const byte of bytes) {
        if (byte === 0xc0) out.push(0xdb, 0xdc);
        else if (byte === 0xdb) out.push(0xdb, 0xdd);
        else out.push(byte);
      }
      out.push(0xc0);
      this.port.feed(Uint8Array.from(out));
    }
    reply(op, value = 0, status = 0) {
      const tail = this.mode === 'rom' ? [status, status && 5, 0, 0] : [status, status && 5];
      const le = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
      this.send([1, op, tail.length, 0, ...le, ...tail]);
    }
    handle(packet) {
      if (packet.length < 8 || packet[0] !== 0) return;
      const op = packet[1];
      this.seen.push(op);
      const word = (at) =>
        (packet[at] | (packet[at + 1] << 8) | (packet[at + 2] << 16) | (packet[at + 3] << 24)) >>>
        0;
      if (op === 0x08) {
        for (let i = 0; i < (this.mode === 'rom' ? 8 : 1); i++)
          this.reply(op, this.mode === 'rom' ? 0x20120707 : 0);
      } else if (op === 0x0a) this.reply(op, this.registers.get(word(8)) ?? 0);
      else if ([0x05, 0x07, 0x09, 0x0d, 0x0f].includes(op)) this.reply(op);
      else if (op === 0x06) {
        this.reply(op);
        this.mode = 'stub';
        this.send([...'OHAI'].map((c) => c.charCodeAt(0)));
      } else this.reply(0, 0, 1);
    }
  }
  class FakePort extends EventTarget {
    constructor(info, rom = false) {
      super();
      this.info = info;
      this.rom = rom ? new FakeRom(this) : null;
      this.readable = null;
      this.writable = null;
      this.isOpen = false;
    }
    getInfo() {
      return { ...this.info };
    }
    async open(options) {
      if (this.isOpen) throw new DOMException('The port is already open.', 'InvalidStateError');
      await passed('open');
      this.isOpen = true;
      window.serialLog.opened.push(options);
      let controller = null;
      this.readable = new ReadableStream({
        start: (given) => {
          controller = given;
        },
      });
      this.feed = (bytes) => controller.enqueue(bytes);
      this.end = () => controller.close();
      this.writable = new WritableStream({
        write: (chunk) =>
          this.rom ? this.rom.receive(new Uint8Array(chunk)) : this.feed(new Uint8Array(chunk)),
      });
    }
    async close() {
      try {
        this.end?.();
      } catch {}
      this.isOpen = false;
      this.readable = null;
      this.writable = null;
      window.serialLog.closed += 1;
    }
    async getSignals() {
      return {
        clearToSend: true,
        dataCarrierDetect: false,
        dataSetReady: true,
        ringIndicator: false,
      };
    }
    async setSignals(signals) {
      if (this.rom) return this.rom.signal(signals);
      window.serialLog.set.push(signals);
    }
  }
  const serial = new EventTarget();
  serial.getPorts = async () => [...granted];
  serial.requestPort = async ({ filters } = {}) => {
    const active = navigator.userActivation.isActive;
    window.serialLog.chooser.push({ active, filters });
    if (!active)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    await passed('chooser');
    const port = new FakePort(ids);
    granted.push(port);
    return port;
  };
  Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => serial });
  window.grant = () => granted.push(new FakePort(ids));
  window.grantEsp = () => {
    const port = new FakePort({ usbVendorId: 0x10c4, usbProductId: 0xea60 }, true);
    granted.push(port);
    window.rom = port.rom;
  };
  window.esptoolLoads = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.name.includes('esptool')) window.esptoolLoads.push(entry.name);
  }).observe({ type: 'resource', buffered: true });
  window.feed = (text) => granted.find((port) => port.isOpen)?.feed(new TextEncoder().encode(text));
  window.unplug = () => {
    const port = granted.shift();
    const event = new Event('disconnect');
    Object.defineProperty(event, 'target', { value: port });
    serial.dispatchEvent(event);
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

async function seven(t, page = null) {
  const opened = page ?? (await chrome.page(t));
  await opened.init(faux);
  await boot(opened);
  return opened;
}

const asCone = (page, command, tag = AGENT) =>
  page.evaluate(
    ({ command, tag }) => window.runs[window.background(command, { user: 'cone', tag })],
    { command, tag }
  );

const started = (page, command, options) =>
  page.evaluate(({ command, options }) => window.background(command, options), {
    command,
    options,
  });

const finished = (page, index) => page.evaluate((index) => window.runs[index], index);

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

test('serial is installed with the base set and its kinds reach slicc-devices through seven’s hook: a typed request opens the chooser at once, and an open port shows a chip whose Close ends a follow read and later writes', async (t) => {
  const page = await seven(t);
  await run(page, 'serial --version; echo "version $?"; serial --help | head -1; echo "help $?"');
  await shows(page, 'version 0');
  assert.match(await screen(page), new RegExp(`\\b${PINNED.replaceAll('.', '\\.')}\\s+version 0`));
  await shows(page, 'serial - access serial ports via Web Serial');
  await shows(page, 'help 0');
  await run(page, 'command -v serial; serial list; echo "none $?"');
  await shows(page, '/usr/bin/serial');
  await shows(page, 'no granted serial ports');
  await shows(page, 'none 0');

  await run(page, 'serial request --vid 0x2e8a; echo "typed $?"');
  await shows(page, 'typed 0');
  assert.match(await screen(page), /serial1\s+0x2e8a:0x0005/);
  assert.deepEqual(await page.evaluate(() => window.serialLog.chooser), [
    { active: true, filters: [{ usbVendorId: 0x2e8a }] },
  ]);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  await run(page, 'serial open serial1 --baud 115200; echo "opened $?"');
  await shows(page, 'opened 0');
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /Serial port open · serial1 · a terminal · \d+:\d\d/);
  await shoot(page, 'serial-live-chip');
  await run(
    page,
    'printf hi | serial write serial1; serial read serial1 --bytes 2; echo " read $?"'
  );
  await shows(page, '2 bytes written');
  await shows(page, 'hi read 0');
  await run(page, 'serial signals serial1 get; serial list; echo "listed $?"');
  await shows(page, 'cts=1 dcd=0 dsr=1 ri=0');
  await shows(page, 'listed 0');
  assert.match(await screen(page), /serial1\s+0x2e8a:0x0005 \[open\]/);
  await run(page, 'serial close serial1; echo "closed $?"');
  await shows(page, 'closed 0');
  await page.until(() => window.chips().length === 0);

  await run(page, 'serial open serial1; serial read serial1 --follow; echo "follow $?"');
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() => window.feed('following-now'));
  await shows(page, 'following-now');
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await shows(page, 'follow 0');
  await page.until(() => window.chips().length === 0);
  await run(page, 'printf x | serial write serial1; echo "after $?"');
  await shows(page, 'serial: serial1 was closed in seven');
  await shows(page, 'after 1');

  await run(page, 'serial open serial1; echo "again $?"');
  await shows(page, 'again 0');
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() => window.unplug());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.serialLog.closed), 3);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a cone in dialout lists, opens and reads a port, but its writes and signal changes are refused before the page sees them, and sudo serial write works', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grant());
  const reads = await asCone(
    page,
    'id -nG; serial list; serial open serial1; serial signals serial1 get; serial read serial1 --timeout-ms 200; echo "reads $?"'
  );
  assert.match(reads.stdout, /\bdialout\b/, reads.stderr);
  assert.match(reads.stdout, /serial1\s+0x2e8a:0x0005/, reads.stderr);
  assert.match(reads.stdout, /cts=1 dcd=0 dsr=1 ri=0/, reads.stderr);
  assert.match(reads.stdout, /reads 0/, reads.stderr);

  const writes = await asCone(
    page,
    'printf hi | serial write serial1; echo "write $?"; serial signals serial1 set --dtr on; echo "set $?"'
  );
  assert.match(writes.stdout, /write 1/);
  assert.match(writes.stdout, /set 1/);
  assert.match(
    writes.stderr,
    /serial: serial\.write is not allowed for this user \(writes need root: sudo serial write serial1\)/
  );
  assert.match(writes.stderr, /serial: serial\.control is not allowed for this user/);
  assert.deepEqual(await page.evaluate(() => window.serialLog.set), []);

  await run(
    page,
    'echo \'NOPASSWD cone Cmnd *\' > /etc/sudoers.d/cone-serial && chmod 0440 /etc/sudoers.d/cone-serial; echo "rule $?"'
  );
  await shows(page, 'rule 0');
  const sudo = await asCone(
    page,
    'printf hi | sudo -n serial write serial1; sudo -n serial signals serial1 set --dtr on; serial read serial1 --bytes 2; echo " sudo $?"'
  );
  assert.match(sudo.stdout, /2 bytes written/, sudo.stderr);
  assert.match(sudo.stdout, /hi sudo 0/, sudo.stderr);
  assert.deepEqual(await page.evaluate(() => window.serialLog.set), [{ dataTerminalReady: true }]);
  assert.deepEqual(page.errors, []);
});

test('esptool is installed with the base set, a cone without sudo gets EACCES before the page sees it, and sudo esptool chip_id detects a fake ESP32 through esptool-js loaded lazily from the installed package', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grantEsp());
  await run(page, 'command -v esptool; esptool --version; echo "version $?"');
  await shows(page, '/usr/bin/esptool');
  await shows(page, 'version 0');
  assert.match(await screen(page), new RegExp(`\\b${PINNED.replaceAll('.', '\\.')}\\s+version 0`));

  const refused = await asCone(page, 'esptool --port serial1 chip_id; echo "cone $?"');
  assert.match(refused.stdout, /cone 1/);
  assert.match(
    refused.stderr,
    /esptool: serial\.esptool is not allowed for this user \(esptool needs root: sudo esptool --port serial1 chip_id\)/
  );
  assert.deepEqual(await page.evaluate(() => window.rom.seen), []);
  assert.deepEqual(await page.evaluate(() => window.esptoolLoads), []);

  await run(
    page,
    'echo \'NOPASSWD cone Cmnd *\' > /etc/sudoers.d/cone-esptool && chmod 0440 /etc/sudoers.d/cone-esptool; echo "rule $?"'
  );
  await shows(page, 'rule 0');
  const chip = await asCone(page, 'sudo -n esptool --port serial1 chip_id; echo "sudo $?"');
  assert.match(chip.stdout, /^Chip type: ESP32$/m, chip.stderr);
  assert.match(chip.stdout, /^MAC: 24:0a:c4:12:34:56$/m, chip.stderr);
  assert.match(chip.stdout, /sudo 0/, chip.stderr);
  assert.ok((await page.evaluate(() => window.rom.seen)).includes(0x08));

  const origin = await page.evaluate(() => location.origin);
  const loads = await page.evaluate(() => window.esptoolLoads);
  const bundle = loads.find((name) => name.includes('/esptool-js/'));
  assert.equal(
    bundle?.split('?')[0],
    `${origin}/node_modules/esptool-js/bundle.js`,
    JSON.stringify(loads)
  );
  assert.ok(
    loads.some((name) =>
      name.startsWith(`${origin}/node_modules/@ai-ecoverse/slicc-devices/page/esptool.mjs`)
    ),
    JSON.stringify(loads)
  );
  assert.equal(
    await page.evaluate((url) => fetch(url).then((r) => r.headers.get('x-served-from')), bundle),
    'opfs'
  );
  assert.deepEqual(page.errors, []);
});

test('an agent’s serial request shows one click item, Choose… opens the chooser inside that click, Cancel refuses with no serial port was chosen, and no other prompt appears', async (t) => {
  const page = await seven(t);
  const chosen = await started(page, 'serial request; echo "agent $?"', {
    user: 'cone',
    tag: AGENT,
  });
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.subject, 'device');
  assert.equal(item.what, 'serial');
  assert.equal(item.here, true);
  assert.equal(item.title, 'Choose a serial port');
  assert.equal(
    item.body,
    "The agent cone:cone wants to use a serial port. Click Choose, then pick it in the browser's list."
  );
  assert.equal(item.action, 'Choose…');
  assert.equal(item.requester.kind, 'agent');
  assert.equal(item.expiresAt - item.createdAt, 300000);
  assert.deepEqual(await page.evaluate(() => window.serialLog.chooser), []);
  await shoot(page, 'serial-click-item');
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  const result = await finished(page, chosen);
  assert.match(result.stdout, /serial1\s+0x2e8a:0x0005/, result.stderr);
  assert.match(result.stdout, /agent 0/);
  assert.match(result.stderr, /serial: waiting for a click in seven's tab: choose a serial port/);
  assert.deepEqual(await page.evaluate(() => window.serialLog.chooser), [
    { active: true, filters: [] },
  ]);
  await page.until(() => window.clickItems().length === 0);

  const cancelled = await started(page, 'serial request; echo "cancelled $?"', {
    user: 'cone',
    tag: AGENT,
  });
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="deny"]`);
  const refused = await finished(page, cancelled);
  assert.match(refused.stdout, /cancelled 1/);
  assert.match(refused.stderr, /serial: no serial port was chosen/);
  assert.equal(await page.evaluate(() => window.serialLog.chooser.length), 1);

  const resting = await asCone(page, 'serial request; echo "resting $?"');
  assert.match(resting.stdout, /resting 1/);
  assert.match(resting.stderr, /serial: no serial port was chosen/);
  await page.until(() => window.clickItems().length === 0);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('the Serial ports switch sits beside capture’s, closes every open port when turned off, refuses every serial kind before the chooser, survives a reload, and is in no kernel file', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    await page.evaluate(() => document.querySelector('slicc-app').model.switches.list()),
    [
      { key: 'camera', label: 'Camera', on: true },
      { key: 'microphone', label: 'Microphone', on: true },
      { key: 'screen', label: 'Screen', on: true },
      { key: 'remote-browser', label: 'Browser control from linked devices', on: true },
      { key: 'serial', label: 'Serial ports', on: true },
    ]
  );
  await page.evaluate(() => window.grant());
  await run(page, 'serial open serial1; echo "opened $?"');
  await shows(page, 'opened 0');
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('serial', false)
  );
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.serialLog.closed), 1);

  await run(page, 'serial list; echo "list off $?"; serial request; echo "request off $?"');
  await shows(page, "serial: serial ports are off in seven's settings");
  await shows(page, 'list off 1');
  await shows(page, 'request off 1');
  const agent = await asCone(page, 'serial request; echo "agent off $?"');
  assert.match(agent.stdout, /agent off 1/);
  assert.match(agent.stderr, /serial ports are off in seven's settings/);
  assert.deepEqual(await page.evaluate(() => window.serialLog.chooser), []);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

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
        .find(({ key }) => key === 'serial')
    ),
    { key: 'serial', label: 'Serial ports', on: false }
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.deep('[data-surface="switches"] [data-id="serial"]'));
  await shoot(page, 'serial-switch');
  await run(page, 'serial list; echo "still off $?"');
  await shows(page, 'still off 1');
  assert.deepEqual(page.errors, []);
});

test('a boot on an /etc/group without dialout adds it with gid 20 and puts every cone and scoop in it, and a scoop the agent adds joins it too', async (t) => {
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
  assert.ok(scoop.groups.includes(20), JSON.stringify(scoop));
  assert.ok(!scoop.groups.includes(27), JSON.stringify(scoop));
  await page.evaluate(() =>
    globalThis.sliccAgentSource().users.add({ name: 'cone-2', groups: [] })
  );
  await run(
    page,
    "grep -v '^dialout:' /etc/group > /tmp/group && cat /tmp/group > /etc/group; grep -c '^dialout:' /etc/group; echo \"gone $?\""
  );
  await shows(page, 'gone 1');

  await page.reload();
  await ready(page);
  const dialout = await page.evaluate(async () =>
    (await globalThis.sliccAgentSource().groups.list()).find((group) => group.name === 'dialout')
  );
  assert.equal(dialout?.gid, 20, JSON.stringify(dialout));
  assert.deepEqual([...dialout.members].sort(), ['cone', 'cone-2', 'scoop-site']);
  const ids = await asCone(page, 'id -nG');
  assert.match(ids.stdout, /\bdialout\b/);
  await assert.rejects(
    page.evaluate(() => globalThis.sliccAgentSource().groups.addMember('dialout', 'scoop-site')),
    /bios refuses the group dialout/
  );
  assert.deepEqual(page.errors, []);
});

const serialSwitch = (page, on) =>
  page.evaluate((on) => document.querySelector('slicc-app').model.switches.set('serial', on), on);

const anyOpen = (page) =>
  page.evaluate(async () =>
    (await navigator.serial.getPorts()).some((port) => port.isOpen === true)
  );

test('turning Serial ports off while a serial open is still in flight closes the port again and refuses the open, and after turning it back on the port is listed closed with nothing buffered', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.grant());
  await page.evaluate(() => window.hold('open'));
  await run(page, 'serial open serial1; echo "pending $?"');
  await page.until(() => window.serialLog.held.includes('open'));
  await serialSwitch(page, false);
  await page.evaluate(() => window.release('open'));
  await shows(page, "serial: serial ports are off in seven's settings");
  await shows(page, 'pending 1');
  assert.equal(await page.evaluate(() => window.serialLog.opened.length), 1);
  assert.equal(await anyOpen(page), false);
  assert.equal(await page.evaluate(() => window.feed('stale-bytes')), undefined);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);

  await serialSwitch(page, true);
  await run(
    page,
    'serial list; serial read serial1 --timeout-ms 200 --hex; echo "read $?"; serial open serial1; serial read serial1 --timeout-ms 300 --hex; echo "fresh $?"'
  );
  await shows(page, 'fresh 0');
  const shown = await screen(page);
  assert.match(shown, /serial1\s+0x2e8a:0x0005\s+serial: serial1 is not open/);
  assert.match(shown, /read 1/);
  assert.match(shown, /fresh 0/);
  assert.doesNotMatch(shown, /stale|73 74 61 6c 65/);
  assert.deepEqual(page.errors, []);
});

test('turning Serial ports off while an agent’s serial request waits on the click, or while the chooser is open, refuses the request with nothing opened or buffered, and the port the browser granted is listed closed once it is back on', async (t) => {
  const page = await seven(t);
  const clicked = await started(page, 'serial request; echo "click off $?"', {
    user: 'cone',
    tag: AGENT,
  });
  await page.until(() => window.clickItems().length === 1);
  await serialSwitch(page, false);
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  const refused = await finished(page, clicked);
  assert.match(refused.stdout, /click off 1/);
  assert.match(refused.stderr, /serial: serial ports are off in seven's settings/);
  assert.deepEqual(await page.evaluate(() => window.serialLog.chooser), []);

  await serialSwitch(page, true);
  await page.evaluate(() => window.hold('chooser'));
  const choosing = await started(page, 'serial request; echo "chooser off $?"', {
    user: 'cone',
    tag: AGENT,
  });
  await page.until(() => window.clickItems().length === 1);
  await pressDeep(page, `${CLICK} [data-action="once"]`);
  await page.until(() => window.serialLog.held.includes('chooser'));
  await serialSwitch(page, false);
  await page.evaluate(() => window.release('chooser'));
  const late = await finished(page, choosing);
  assert.match(late.stdout, /chooser off 1/);
  assert.match(late.stderr, /serial: serial ports are off in seven's settings/);
  assert.doesNotMatch(late.stdout, /serial1\s+0x2e8a/);
  assert.deepEqual(await page.evaluate(() => window.serialLog.chooser), [
    { active: true, filters: [] },
  ]);
  assert.equal(await page.evaluate(() => window.serialLog.opened.length), 0);

  await serialSwitch(page, true);
  const after = await asCone(
    page,
    'serial list; serial read serial1 --timeout-ms 200; echo "read $?"'
  );
  assert.match(after.stdout, /^serial1\s+0x2e8a:0x0005$/m);
  assert.doesNotMatch(after.stdout, /\[open\]/);
  assert.match(after.stdout, /read 1/);
  assert.match(after.stderr, /serial: serial1 is not open/);
  assert.equal(await anyOpen(page), false);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);
  assert.deepEqual(page.errors, []);
});
