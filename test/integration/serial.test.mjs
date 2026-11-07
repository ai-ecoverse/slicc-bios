import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const AGENT = '{"kind":"agent","agentId":"cone:cone"}';
const CLICK = 'dialog[data-kind="click"]';

const faux = () => {
  globalThis.sliccKernelDebug = true;
  const ids = { usbVendorId: 0x2e8a, usbProductId: 0x0005 };
  const granted = [];
  window.serialLog = { chooser: [], opened: [], closed: 0, set: [] };
  class FakePort extends EventTarget {
    constructor(info) {
      super();
      this.info = info;
      this.readable = null;
      this.writable = null;
      this.isOpen = false;
    }
    getInfo() {
      return { ...this.info };
    }
    async open(options) {
      if (this.isOpen) throw new DOMException('The port is already open.', 'InvalidStateError');
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
        write: (chunk) => this.feed(new Uint8Array(chunk)),
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
    const port = new FakePort(ids);
    granted.push(port);
    return port;
  };
  Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => serial });
  window.grant = () => granted.push(new FakePort(ids));
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
  await run(page, 'serial --help | head -1; echo "help $?"');
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
  await run(page, 'serial signals serial1 get; serial list');
  await shows(page, 'cts=1 dcd=0 dsr=1 ri=0');
  assert.match(await screen(page), /serial1\s+0x2e8a:0x0005 \[open\]/);
  await run(page, 'serial close serial1; echo "closed $?"');
  await shows(page, 'closed 0');
  await page.until(() => window.chips().length === 0);

  await run(page, 'serial open serial1; serial read serial1 --follow; echo "follow $?"');
  await page.until(() => window.chips().length === 1);
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
  assert.ok(scoop.groups.includes('dialout'), JSON.stringify(scoop));
  assert.ok(!scoop.groups.includes('sudo'), JSON.stringify(scoop));
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
