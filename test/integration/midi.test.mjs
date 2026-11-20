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
const WAITING = "midi: waiting for the browser's MIDI permission prompt in seven's tab";
const OFF = "MIDI devices are off in seven's settings";

const faux = () => {
  globalThis.sliccKernelDebug = true;
  window.midiLog = {
    requests: [],
    opens: 0,
    closes: 0,
    played: [],
    scheduled: [],
    cleared: 0,
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
    window.midiLog.held.push(what);
    await held.gate;
  };
  class FakePort extends EventTarget {
    constructor(id, type) {
      super();
      this.id = id;
      this.type = type;
      this.name = 'IAC Driver Bus 1';
      this.manufacturer = 'Apple';
      this.version = '1.0';
      this.state = 'connected';
      this.connection = 'closed';
      this.onmidimessage = null;
    }
    async open() {
      await passed(`open ${this.type}`);
      this.connection = 'open';
      window.midiLog.opens += 1;
      return this;
    }
    async close() {
      if (this.connection === 'open') window.midiLog.closes += 1;
      this.connection = 'closed';
      return this;
    }
  }
  class FakeOutput extends FakePort {
    send(data, timestamp) {
      const bytes = [...data];
      if (timestamp === undefined || timestamp <= performance.now()) {
        window.midiLog.played.push(bytes);
        return;
      }
      const item = { bytes, timestamp };
      window.midiLog.scheduled.push(item);
      setTimeout(() => {
        const at = window.midiLog.scheduled.indexOf(item);
        if (at < 0) return;
        window.midiLog.scheduled.splice(at, 1);
        window.midiLog.played.push(bytes);
      }, timestamp - performance.now());
    }
    clear() {
      window.midiLog.cleared += 1;
      window.midiLog.scheduled.length = 0;
    }
  }
  const input = new FakePort('iac-bus-1-in', 'input');
  const output = new FakeOutput('iac-bus-1-out', 'output');
  const access = new EventTarget();
  access.inputs = new Map([[input.id, input]]);
  access.outputs = new Map([[output.id, output]]);
  access.sysexEnabled = false;
  access.onstatechange = null;
  Object.defineProperty(Navigator.prototype, 'requestMIDIAccess', {
    configurable: true,
    writable: true,
    value: async (options = {}) => {
      window.midiLog.requests.push({
        sysex: options.sysex === true,
        active: navigator.userActivation.isActive,
      });
      await passed('request');
      if (options.sysex === true) access.sysexEnabled = true;
      return access;
    },
  });
  window.play = (bytes) =>
    input.onmidimessage?.({ data: Uint8Array.from(bytes), timeStamp: performance.now() });
  window.listening = () => typeof input.onmidimessage === 'function';
  window.inputOpen = () => input.connection === 'open';
  window.outputOpen = () => output.connection === 'open';
  window.unplug = () => {
    output.state = 'disconnected';
    output.connection = 'closed';
    const event = new Event('statechange');
    event.port = output;
    access.dispatchEvent(event);
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
  window.streamed = [];
  window.background = (command, options) => {
    const index = window.runs.length;
    window.streamed.push('');
    const started = (async () => {
      const client = await globalThis.sliccRequestsClient();
      try {
        return await client.run(['bash', '-c', command], {
          ...options,
          onStdout: (text) => {
            window.streamed[index] += text;
          },
        });
      } finally {
        await client.close();
      }
    })();
    window.runs.push(started);
    return index;
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

const midiSwitch = (page, on) =>
  page.evaluate((on) => document.querySelector('slicc-app').model.switches.set('midi', on), on);

const granted = async (page) => {
  const asked = await asCone(page, 'midi request; echo "granted $?"');
  assert.match(asked.stdout, /granted 0/, asked.stderr);
};

test('midi is installed with the base set, a cone in audio requests access and lists the ports with no click item, whether typed or the agent’s, and its midi receive gets a message from the port', async (t) => {
  const page = await seven(t);
  await run(page, 'command -v midi; midi --version; echo "version $?"');
  await shows(page, '/usr/bin/midi');
  await shows(page, 'version 0');
  assert.match(await screen(page), new RegExp(`\\b${PINNED.replaceAll('.', '\\.')}\\s+version 0`));

  await run(
    page,
    'sudo -u cone id -nG; sudo -u cone midi list; echo "before $?"; sudo -u cone midi request; echo "typed $?"'
  );
  await shows(page, 'typed 0');
  const typed = await screen(page);
  assert.match(typed, /\baudio\b/);
  assert.match(typed, /midi: no MIDI ports \(midi request\)\s+before 0/);
  assert.match(typed, /midi1\s+in\s+Apple IAC Driver Bus 1\s+midi2\s+out\s+Apple IAC Driver Bus 1/);
  assert.ok(typed.includes(WAITING), typed);
  assert.equal(await page.evaluate(() => window.midiLog.requests.length), 1);
  assert.equal(await page.evaluate(() => window.midiLog.requests[0].sysex), false);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  const agent = await asCone(page, 'midi request --sysex; echo "agent $?"; midi list');
  assert.match(agent.stdout, /agent 0/, agent.stderr);
  assert.match(agent.stdout, /^midi1\tin\tApple IAC Driver Bus 1$/m);
  assert.match(agent.stdout, /^midi2\tout\tApple IAC Driver Bus 1$/m);
  assert.ok(agent.stderr.includes(WAITING), agent.stderr);
  assert.deepEqual(await page.evaluate(() => window.midiLog.requests.map(({ sysex }) => sysex)), [
    false,
    true,
  ]);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  const receiving = await started(page, 'midi receive midi1 --count 1; echo "received $?"');
  await page.until(() => window.listening());
  await page.evaluate(() => window.play([0x90, 0x3c, 0x7f]));
  const received = await finished(page, receiving);
  assert.match(received.stdout, /^90 3c 7f\nreceived 0$/m, received.stderr);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('a cone in audio gets EACCES on midi send before the page sees it, and sudo -n midi send plays', async (t) => {
  const page = await seven(t);
  await granted(page);
  const sent = await asCone(page, 'midi send midi2 --hex "90 3c 7f"; echo "send $?"');
  assert.match(sent.stdout, /send 1/);
  assert.match(sent.stderr, /midi: midi\.send is not allowed for this user/);
  assert.deepEqual(await page.evaluate(() => window.midiLog.played), []);
  assert.equal(await page.evaluate(() => window.midiLog.opens), 0);

  await run(
    page,
    'echo \'NOPASSWD cone Cmnd *\' > /etc/sudoers.d/cone-midi && chmod 0440 /etc/sudoers.d/cone-midi; echo "rule $?"'
  );
  await shows(page, 'rule 0');
  const sudo = await asCone(
    page,
    'printf \'\\220\\074\\177\' | sudo -n midi send midi2; echo "sudo $?"'
  );
  assert.match(sudo.stdout, /sudo 0/, sudo.stderr);
  assert.deepEqual(await page.evaluate(() => window.midiLog.played), [[0x90, 0x3c, 0x7f]]);
  assert.deepEqual(page.errors, []);
});

test('an open MIDI port shows a chip whose Close closes it and ends a midi receive on it, and unplugging the port takes its chip away', async (t) => {
  const page = await seven(t);
  await granted(page);
  await run(page, 'midi open midi2; echo "opened $?"');
  await shows(page, 'opened 0');
  await page.until(() => window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /MIDI port open · midi2 \(IAC Driver Bus 1\) · a terminal · \d+:\d\d/);
  await shoot(page, 'midi-live-chip');
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.outputOpen()), false);

  const receiving = await started(page, 'midi receive midi1; echo "receive $?"');
  await page.until(() => window.listening() && window.chips().length === 1);
  const [receiveChip] = await page.evaluate(() => window.chips());
  assert.match(receiveChip, /MIDI port open · midi1 \(IAC Driver Bus 1\) · cone · \d+:\d\d/);
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  const ended = await finished(page, receiving);
  assert.match(ended.stdout, /receive 1/);
  assert.match(ended.stderr, /midi: midi1 was closed in seven/);
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.inputOpen()), false);
  assert.equal(await page.evaluate(() => window.listening()), false);

  await run(page, 'midi open midi2; echo "again $?"');
  await shows(page, 'again 0');
  await page.until(() => window.chips().length === 1);
  await page.evaluate(() => window.unplug());
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(page.errors, []);
});

test('the chip goes when a midi receive ends, whether interrupted or by --count, and the next receive on that input shows it again, ended by Close or by the switch', async (t) => {
  const page = await seven(t);
  await granted(page);
  const interrupted = await started(page, 'midi receive midi1; echo "interrupted $?"');
  await page.until(() => window.listening() && window.chips().length === 1);
  const [chip] = await page.evaluate(() => window.chips());
  assert.match(chip, /MIDI port open · midi1 \(IAC Driver Bus 1\) · cone · \d+:\d\d/);
  await page.evaluate(() => window.play([0x90, 0x3c, 0x7f]));
  await page.until((index) => window.streamed[index] === '90 3c 7f\n', interrupted);
  const sent = await asCone(page, `pkill -INT -f 'midi[^ ]* receive midi1$'; echo "sent $?"`);
  assert.match(sent.stdout, /sent 0/, sent.stderr);
  const stopped = await finished(page, interrupted);
  assert.match(stopped.stdout, /^90 3c 7f\ninterrupted 130$/m, stopped.stderr);
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.inputOpen()), false);
  assert.equal(await page.evaluate(() => window.listening()), false);

  const counted = await started(page, 'midi receive midi1 --count 1; echo "counted $?"');
  await page.until(() => window.listening() && window.chips().length === 1);
  await page.evaluate(() => window.play([0x80, 0x3c, 0x00]));
  const once = await finished(page, counted);
  assert.match(once.stdout, /^80 3c 00\ncounted 0$/m, once.stderr);
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.inputOpen()), false);

  const closing = await started(page, 'midi receive midi1; echo "closed $?"');
  await page.until(() => window.listening() && window.chips().length === 1);
  await page.evaluate(() => window.deep('[data-surface="live"] [data-action="live-act"]').click());
  const closed = await finished(page, closing);
  assert.match(closed.stdout, /closed 1/);
  assert.match(closed.stderr, /midi: midi1 was closed in seven/);
  await page.until(() => window.chips().length === 0);

  const switching = await started(page, 'midi receive midi1; echo "switched $?"');
  await page.until(() => window.listening() && window.chips().length === 1);
  await midiSwitch(page, false);
  const switched = await finished(page, switching);
  assert.match(switched.stdout, /switched 1/);
  assert.ok(switched.stderr.includes(OFF), switched.stderr);
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.inputOpen()), false);
  assert.equal(await page.evaluate(() => window.listening()), false);
  assert.deepEqual(page.errors, []);
});

test('the MIDI devices switch sits after Bluetooth devices, ends a midi receive and closes every open port when turned off, refuses every midi kind, survives a reload, and is in no kernel file', async (t) => {
  const page = await seven(t);
  assert.deepEqual(
    (await page.evaluate(() => document.querySelector('slicc-app').model.switches.list())).slice(
      -6
    ),
    [
      { key: 'serial', label: 'Serial ports', on: true },
      { key: 'usb', label: 'USB devices', on: true },
      { key: 'hid', label: 'HID devices', on: true },
      { key: 'ble', label: 'Bluetooth devices', on: true },
      { key: 'midi', label: 'MIDI devices', on: true },
      { key: 'previews', label: 'Public previews', on: true },
    ]
  );
  await granted(page);
  const opened = await asCone(page, 'midi open midi2; echo "cone $?"');
  assert.match(opened.stdout, /cone 0/, opened.stderr);
  await page.until(() => window.chips().length === 1);
  await run(page, 'midi receive midi1; echo "receive $?"');
  await page.until(() => window.listening() && window.chips().length === 2);
  await page.evaluate(() => window.play([0xb0, 0x07, 0x64]));
  await shows(page, 'b0 07 64');
  await midiSwitch(page, false);
  await shows(page, 'receive 1');
  assert.match(await screen(page), new RegExp(`b0 07 64\\s+midi: ${OFF}\\s+receive 1`));
  await page.until(() => window.chips().length === 0);
  assert.equal(await page.evaluate(() => window.inputOpen()), false);
  assert.equal(await page.evaluate(() => window.outputOpen()), false);
  assert.equal(await page.evaluate(() => window.listening()), false);

  await run(
    page,
    'midi list; echo "list off $?"; midi request; echo "request off $?"; midi open midi2; echo "open off $?"; midi close midi2; echo "close off $?"; midi receive midi1 --count 1; echo "receive off $?"; midi send midi2 --hex "90 3c 7f"; echo "send off $?"'
  );
  await shows(page, 'send off 1');
  const off = await screen(page);
  for (const name of ['list', 'request', 'open', 'close', 'receive', 'send'])
    assert.match(off, new RegExp(`midi: ${OFF}\\s+${name} off 1`));
  const agent = await asCone(page, 'midi request; echo "agent off $?"');
  assert.match(agent.stdout, /agent off 1/);
  assert.ok(agent.stderr.includes(OFF), agent.stderr);
  assert.equal(await page.evaluate(() => window.midiLog.requests.length), 1);
  assert.deepEqual(await page.evaluate(() => window.midiLog.played), []);
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
        .filter(({ key }) => ['serial', 'usb', 'hid', 'ble', 'midi'].includes(key))
    ),
    [
      { key: 'serial', label: 'Serial ports', on: true },
      { key: 'usb', label: 'USB devices', on: true },
      { key: 'hid', label: 'HID devices', on: true },
      { key: 'ble', label: 'Bluetooth devices', on: true },
      { key: 'midi', label: 'MIDI devices', on: false },
    ]
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.deep('[data-surface="switches"] [data-id="midi"]'));
  await shoot(page, 'midi-switch');
  await run(page, 'midi list; echo "still off $?"');
  await shows(page, 'still off 1');
  await midiSwitch(page, true);
  await run(page, 'midi request; echo "back on $?"');
  await shows(page, 'back on 0');
  assert.match(await screen(page), /midi2\s+out\s+Apple IAC Driver Bus 1\s+back on 0/);
  assert.deepEqual(page.errors, []);
});

test('turning MIDI devices off while midi request waits on the browser’s permission prompt refuses it with no ports, and back on a new request lists them', async (t) => {
  const page = await seven(t);
  await page.evaluate(() => window.hold('request'));
  const asking = await started(page, 'midi request; echo "pending $?"');
  await page.until(() => window.midiLog.held.includes('request'));
  await midiSwitch(page, false);
  await page.evaluate(() => window.release('request'));
  const refused = await finished(page, asking);
  assert.match(refused.stdout, /pending 1/);
  assert.doesNotMatch(refused.stdout, /IAC Driver/);
  assert.ok(refused.stderr.includes(OFF), refused.stderr);
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  await midiSwitch(page, true);
  const after = await asCone(page, 'midi list; echo "listed $?"; midi request; echo "asked $?"');
  assert.match(after.stderr, /midi: no MIDI ports \(midi request\)/);
  assert.match(after.stdout, /listed 0/);
  assert.match(after.stdout, /^midi1\tin\tApple IAC Driver Bus 1$/m, after.stderr);
  assert.match(after.stdout, /asked 0/);
  assert.equal(await page.evaluate(() => window.midiLog.requests.length), 2);
  assert.equal(await page.evaluate(() => window.midiLog.opens), 0);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);
  assert.deepEqual(page.errors, []);
});

test('turning MIDI devices off while a midi open is still in flight closes the port again and refuses the open with no chip, and back on the port opens afresh', async (t) => {
  const page = await seven(t);
  await granted(page);
  await page.evaluate(() => window.hold('open output'));
  await run(page, 'midi open midi2; echo "pending $?"');
  await page.until(() => window.midiLog.held.includes('open output'));
  await midiSwitch(page, false);
  await page.evaluate(() => window.release('open output'));
  await shows(page, 'pending 1');
  assert.match(await screen(page), new RegExp(`midi: ${OFF}\\s+pending 1`));
  await page.until(() => !window.outputOpen());
  assert.equal(await page.evaluate(() => window.midiLog.opens), 1);
  assert.deepEqual(await page.evaluate(() => window.chips()), []);

  await midiSwitch(page, true);
  await run(page, 'midi open midi2; echo "fresh $?"');
  await shows(page, 'fresh 0');
  await page.until(() => window.chips().length === 1);
  assert.equal(await page.evaluate(() => window.midiLog.opens), 2);
  assert.equal(await page.evaluate(() => window.outputOpen()), true);
  assert.deepEqual(page.errors, []);
});

test('turning MIDI devices off after a timed midi send clears what the output scheduled, so nothing plays once the switch is off', async (t) => {
  const page = await seven(t);
  await granted(page);
  const at = await page.evaluate(() => Math.round(performance.now() + 4900));
  await run(
    page,
    `{ printf '%s\\n' '{"kind":"midi.send","handle":"midi2","timestamp":${at}}'; printf '\\220\\074\\177'; } | cat > /dev/embedder; echo "timed $?"`
  );
  await shows(page, 'timed 0');
  assert.deepEqual(await page.evaluate(() => window.midiLog.scheduled), [
    { bytes: [0x90, 0x3c, 0x7f], timestamp: at },
  ]);
  await page.until(() => window.chips().length === 1);
  await midiSwitch(page, false);
  await page.until(() => window.midiLog.cleared > 0 && window.chips().length === 0);
  assert.deepEqual(await page.evaluate(() => window.midiLog.scheduled), []);
  assert.equal(await page.evaluate(() => window.outputOpen()), false);
  await page.until((at) => performance.now() > at + 500, at);
  assert.deepEqual(await page.evaluate(() => window.midiLog.played), []);
  assert.deepEqual(page.errors, []);
});

test('a boot on an /etc/group without audio adds it with gid 29 and puts every cone and scoop in it, and a scoop the agent adds joins it too', async (t) => {
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
  assert.ok(scoop.groups.includes(29), JSON.stringify(scoop));
  assert.ok(!scoop.groups.includes(27), JSON.stringify(scoop));
  await page.evaluate(() =>
    globalThis.sliccAgentSource().users.add({ name: 'cone-2', groups: [] })
  );
  await run(
    page,
    "grep -v '^audio:' /etc/group > /tmp/group && cat /tmp/group > /etc/group; grep -c '^audio:' /etc/group; echo \"gone $?\""
  );
  await shows(page, 'gone 1');

  await page.reload();
  await ready(page);
  const audio = await page.evaluate(async () =>
    (await globalThis.sliccAgentSource().groups.list()).find((group) => group.name === 'audio')
  );
  assert.equal(audio?.gid, 29, JSON.stringify(audio));
  assert.deepEqual([...audio.members].sort(), ['cone', 'cone-2', 'scoop-site']);
  const ids = await asCone(page, 'id -nG');
  assert.match(ids.stdout, /\baudio\b/);
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
  assert.match(scoopIds.stdout, /\baudio\b/, scoopIds.stderr);
  assert.doesNotMatch(scoopIds.stdout, /\bsudo\b/);
  await assert.rejects(
    page.evaluate(() => globalThis.sliccAgentSource().groups.addMember('audio', 'scoop-site')),
    /bios refuses the group audio/
  );
  assert.deepEqual(page.errors, []);
});
