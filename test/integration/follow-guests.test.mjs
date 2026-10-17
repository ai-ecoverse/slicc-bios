import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, connectAccount, listsAccount, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const LABEL = 'Anna';
const REFUSED = 'This guest link isn’t valid any more.';
const EVENTS = [['content-type', 'application/vnd.amazon.eventstream']];

const stream = (blocks, stopReason) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    ...blocks,
    eventFrame('messageStop', { stopReason }),
    eventFrame('metadata', {
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      metrics: { latencyMs: 1 },
    }),
  ]);
const spoken = (words) =>
  stream(
    [
      eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: words } }),
      eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    ],
    'end_turn'
  );
const runs = (id, command) =>
  stream(
    [
      eventFrame('contentBlockStart', {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: id, name: 'bash' } },
      }),
      eventFrame('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { toolUse: { input: JSON.stringify({ command }) } },
      }),
      eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    ],
    'tool_use'
  );
const lastTurn = (body) => {
  try {
    const sent = JSON.parse(body.toString());
    return {
      tools: !!sent.toolConfig?.tools?.length,
      content: sent.messages?.at(-1)?.content ?? [],
    };
  } catch {
    return { tools: false, content: [] };
  }
};

let release = null;
const held = new Promise((resolve) => {
  release = resolve;
});
let holding = false;
const asked = [];

const owners = await launch({ agent: true, timeout: 60000 });
const guests = await launch({
  agent: true,
  timeout: 60000,
  args: ['--disable-features=IsolateSandboxedIframes'],
});
const proxy = await fakeProxy({
  origin: new URL(owners.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    asked.push(body.toString());
    const turn = lastTurn(body);
    const says = (text) => turn.content.some((item) => item.text?.includes(text));
    const result = turn.content.find((item) => item.toolResult)?.toolResult?.toolUseId;
    if (result === 'guest-look')
      return { status: 200, headers: EVENTS, body: spoken('Done looking.') };
    if (result === 'guest-sudo')
      return { status: 200, headers: EVENTS, body: spoken('Sudo answered.') };
    if (turn.tools && says('Look around')) {
      holding = true;
      await held;
      return { status: 200, headers: EVENTS, body: runs('guest-look', 'ls /') };
    }
    if (turn.tools && says('Use sudo'))
      return { status: 200, headers: EVENTS, body: runs('guest-sudo', 'sudo ls -la /etc') };
    if (says('Not a steer'))
      return { status: 200, headers: EVENTS, body: spoken('Got the follow-up from Anna.') };
    if (says('Hello from Anna'))
      return { status: 200, headers: EVENTS, body: spoken('Nice to meet you, Anna.') };
    return { status: 200, headers: EVENTS, body: spoken('Hello from the owner.') };
  },
});
after(async () => {
  await proxy.close();
  await Promise.all([owners.close(), guests.close()]);
});

function deep() {
  window.deep = (...path) => {
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && find(element.shadowRoot, selector);
        if (inner) return inner;
      }
      return null;
    };
    let node = document;
    for (const selector of path) {
      node = find(node.shadowRoot ?? node, selector);
      if (!node) return null;
    }
    return node;
  };
  window.netPanel = () =>
    window.deep('slicc-dock')?.content?.('network')?.shadowRoot ??
    window.deep('slicc-network')?.shadowRoot ??
    null;
  window.invite = (selector) =>
    window.deep('slicc-guest-invite')?.shadowRoot?.querySelector(selector);
}

const seats = (page) =>
  page.evaluate(() =>
    (document.querySelector('slicc-app').model.guests?.list() ?? []).map((seat) => ({
      id: seat.id,
      label: seat.label,
      agentId: seat.agentId,
      expiresAt: seat.expiresAt,
      connected: seat.connected,
    }))
  );

const transcript = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active()));
  });

const guestSaid = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-chat').model ?? {};
    return agent ? JSON.stringify(agent.messages(agent.active())) : '';
  });

async function shootGuest(page, name) {
  const capture = async (file, clip) => {
    await page.within(10000, async () => {
      await document.fonts.ready;
      const chat = document.querySelector('slicc-chat');
      const turns = chat.shadowRoot?.querySelectorAll('swc-conversation-turn').length ?? 0;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return !chat.hidden && turns > 0 && chat.updateComplete.then(() => true);
    });
    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {}),
    });
    await writeFile(new URL(file, page.dir), Buffer.from(data, 'base64'));
  };
  const scheme = async (value) => {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    });
    await page.until(
      (value) => document.querySelector('.swc-theme').classList.contains(`swc-theme--${value}`),
      value
    );
  };
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const color of ['light', 'dark']) {
    await scheme(color);
    await capture(`${name}-${color}-1280.png`);
  }
  await scheme('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await capture(`${name}-light-420.png`, { x: 0, y: 0, width: 420, height: 800, scale: 1 });
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
}

function probeLink(url, name) {
  return (async () => {
    const { createFollow, hubClient, hubOrigin } = await import('/os/follow.js');
    const follow = createFollow({
      kept: { hub: hubOrigin(url), url },
      storage: { setItem() {}, removeItem() {} },
      post: hubClient({ origin: null, fetch: (...args) => fetch(...args) }),
      makePeer: (config) => new RTCPeerConnection(config),
      cert: () => RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }),
      forget: async () => undefined,
      hello: () => ({ name, mode: 'remote', kind: 'guest', caps: [], node: name }),
    });
    window[name] = follow;
    follow.start();
    return true;
  })();
}

function probeStreams() {
  return (async () => {
    const outcome = (opening) =>
      opening.then(
        (stream) => {
          stream.close();
          return 'opened';
        },
        (error) => error.code ?? error.message
      );
    const refused = {};
    for (const kind of [
      'terminal',
      'kernel',
      'fs',
      'agent',
      'mounts',
      'browsers',
      'tcp',
      'http',
      'resolve',
      'join',
      'permissions',
      'unlink',
    ])
      refused[kind] = await outcome(window.probe.open({ kind }));
    const { linkEndpoint, connectAgent } = await import(
      '/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/page.js'
    );
    const { pumpLink, streamSink } = await import('/os/agent.js');
    const first = await window.probe.open({ kind: 'pi' });
    const second = await outcome(window.probe.open({ kind: 'pi' }));
    const endpoint = linkEndpoint(streamSink(first));
    void pumpLink(first, endpoint);
    const owner = await Promise.race([
      connectAgent(endpoint).then(
        () => 'connected',
        (error) => error.code ?? error.message
      ),
      new Promise((resolve) => setTimeout(resolve, 20000, 'no answer')),
    ]);
    return { refused, second, owner };
  })();
}

function rawWire() {
  return (async () => {
    const base = '/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/';
    const [{ linkEndpoint }, { PortLink }, { clientHost }, services] = await Promise.all([
      import(`${base}page.js`),
      import(`${base}wire.js`),
      import(`${base}client.js`),
      import(`${base}services.js`),
    ]);
    const { pumpLink, streamSink } = await import('/os/agent.js');
    const stream = await window.raw.open({ kind: 'pi' });
    const endpoint = linkEndpoint(streamSink(stream));
    void pumpLink(stream, endpoint);
    const link = new PortLink(endpoint);
    await link.hello;
    const wire = { link, rewrite: null };
    const send = link.send.bind(link);
    link.send = (frame) => send(wire.rewrite ? wire.rewrite(frame) : frame);
    const host = clientHost(link, 'raw');
    const answer = (promise) =>
      Promise.race([
        promise.then(
          (value) => (value?.variant ? `held ${value.variant}` : 'accepted'),
          (error) => error.code ?? error.message
        ),
        new Promise((resolve) => setTimeout(resolve, 20000, 'no answer')),
      ]);
    const holds = {};
    for (const name of [
      'AgentControl',
      'AgentTranscript',
      'AgentSettings',
      'AgentRemoteService',
      'AgentPagesService',
      'AgentSudoService',
    ])
      holds[name] = await answer(host.get(services[name], {}, {}));
    wire.rewrite = (frame) =>
      frame.t === 'hold' ? { ...frame, principal: { seat: 'owner' }, origin: 'owner' } : frame;
    holds.claimingOwner = await answer(host.get(services.AgentControl, {}, {}));
    wire.rewrite = null;
    const guest = await host.get(services.AgentGuestService, {}, {});
    wire.call = (member, args) => host.root((ctx) => guest[member](args, ctx), {});
    wire.forge = (member, args) => {
      wire.rewrite = (frame) =>
        frame.t === 'call' && frame.member === 'propose' ? { ...frame, member, args } : frame;
      return answer(
        wire.call('propose', [{ text: `forged ${member}`, requestId: crypto.randomUUID() }])
      ).finally(() => {
        wire.rewrite = null;
      });
    };
    window.wire = wire;
    return {
      holds,
      variant: guest.variant,
      open: await answer(
        wire.call('guestOpen', [{ id: 'x', label: 'x', agentId: 'x', expiresAt: null, gates: {} }])
      ),
      revoke: await answer(wire.call('guestRevoke', ['s1'])),
    };
  })();
}

function rawPropose(text) {
  return window.wire.call('propose', [{ text, requestId: crypto.randomUUID() }]);
}

function rawForge([cone, approval]) {
  return (async () => {
    const forged = {};
    const tries = {
      abort: [],
      stopAgent: [cone],
      compactAgent: [cone, null],
      configure: [
        {
          agentId: cone,
          model: { provider: 'amazon-bedrock', modelId: 'other' },
          thinkingLevel: 'high',
        },
      ],
      decide: [approval, 'once', null],
      send: [
        {
          agentId: cone,
          text: 'Steer from a raw guest',
          whenBusy: 'steer',
          requestId: 'raw-steer',
        },
      ],
      followUp: [
        {
          agentId: cone,
          text: 'Follow-up from a raw guest',
          whenBusy: 'followUp',
          requestId: 'raw-follow',
        },
      ],
      createCone: ['Renamed by a raw guest'],
      newChat: [cone],
      freeze: [cone],
      prompt: [{ text: 'Prompt from a raw guest' }],
    };
    for (const [name, args] of Object.entries(tries))
      forged[name] = await window.wire.forge(name === 'followUp' ? 'send' : name, args);
    return forged;
  })();
}

test('the owner invites a guest to a live cone; the guest chats through a seat link, can’t drive the cone or reach other streams, a follower sees the seat, and Revoke ends it at once', {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await owners.page(t);
  const guest = await guests.page(t);
  await owner.init(deep);
  await guest.init(deep);
  await owner.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(owner);
  await owner.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await owner.reload();
  await ready(owner);
  await guest.goto('/');
  await ready(guest);
  await Promise.all([
    agentUp(owner, { label: 'owner agent' }),
    agentUp(guest, { label: 'guest browser agent' }),
  ]);
  await listsAccount(owner, 'amazon-bedrock');
  await connectAccount(owner, 'amazon-bedrock', KEY);
  await owner.until(
    () => document.querySelector('slicc-app').model.network.status().links?.sync === 'ready'
  );

  await owner.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Welcome, Anna');
  });
  await owner.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active())).includes('Hello from the owner.');
  });
  const cone = await owner.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return { id: agent.active(), name: agent.list().find((a) => a.id === agent.active()).name };
  });

  await owner.evaluate(() => document.querySelector('slicc-app').show('network'));
  await owner.until(() => !!window.netPanel()?.querySelector('section[data-guests]'));
  assert.equal(
    await owner.evaluate(() => !!window.netPanel().querySelector('[data-guests-empty]')),
    true
  );
  await shoot(owner, 'guests-empty', { show: 'network', target: 'section[data-guests]' });

  await owner.evaluate(() => window.netPanel().querySelector('[data-action=invite-guest]').click());
  await owner.until(() => !!window.invite('dialog[open]'));
  await owner.until(
    () =>
      window.invite('#guest-name') === window.deep('slicc-guest-invite').shadowRoot.activeElement
  );
  await owner.insert(LABEL);
  await shoot(owner, 'guests-invite', {});
  const before = Date.now();
  await owner.evaluate(() => window.invite('[data-action=create-guest-link]').click());
  await owner.until(() => !!window.invite('dialog[data-guest-invite=link]'));
  const link = await owner.evaluate(() => window.invite('[data-copy=guest-url]').value);
  const seatAt = new URL(link);
  assert.equal(seatAt.origin, new URL(owners.url).origin);
  assert.equal(seatAt.pathname, '/');
  const hubSeat = new URLSearchParams(seatAt.hash.slice(1)).get('seat');
  assert.equal(hubSeat, `${hub.url}/join/g1`);
  assert.deepEqual(
    hub.minted.map(({ label, unitJid }) => ({ label, unitJid })),
    [{ label: LABEL, unitJid: cone.id }]
  );
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(hub.minted[0].ttlMs - week) < 5 * 60 * 1000, `ttl ${hub.minted[0].ttlMs}`);
  await shoot(owner, 'guests-invite-link', {});
  await owner.evaluate(() => window.invite('[data-action=done-guest]').click());
  await owner.until(() => !window.deep('slicc-guest-invite'));

  const [minted] = await seats(owner);
  assert.equal(minted.id, 's1');
  assert.equal(minted.label, LABEL);
  assert.equal(minted.agentId, cone.id);
  assert.equal(minted.connected, false);
  assert.ok(Math.abs(minted.expiresAt - (before + week)) < 5 * 60 * 1000);
  assert.deepEqual(
    await owner.evaluate(() =>
      [...window.netPanel().querySelectorAll('li[data-seat]')].map((row) => [
        row.dataset.seat,
        row.dataset.connected,
        row.querySelector('[data-expiry]').textContent,
      ])
    ),
    [['s1', 'false', 'Expires in 7 days']]
  );
  assert.ok(
    !(await owner.evaluate(() => JSON.stringify({ ...localStorage }))).includes('/join/g1'),
    'the owner keeps no seat link'
  );

  await guest.goto(`/${seatAt.hash}`);
  await guest.until(() => location.pathname === '/os/join.html' && !location.hash);
  await guest
    .within(
      10 * 60 * 1000,
      () => document.querySelector('slicc-chat')?.model?.seat?.label === 'Anna'
    )
    .catch(async (error) => {
      const state = await guest.evaluate(
        () => document.querySelector('[data-seat-state]')?.textContent
      );
      throw new Error(
        `the guest page never joined: ${error.message}\nstate: ${state}\nconsole:\n${guest.console.slice(-15).join('\n')}`
      );
    });
  assert.equal(
    await guest.evaluate(() => sessionStorage.getItem('slicc-os.seat')),
    `${hub.url}/join/g1`
  );
  await owner.until(
    () => document.querySelector('slicc-app').model.guests.list()[0]?.connected === true
  );
  await guest.until(() => {
    const chat = document.querySelector('slicc-chat');
    const { agent } = chat.model;
    const welcome = agent.messages(agent.active()).find((m) => m.text === 'Welcome, Anna');
    return (
      welcome &&
      chat.shadowRoot.querySelector(`swc-conversation-turn[data-id="${welcome.id}"] .who`)
        ?.textContent === 'From the host'
    );
  });
  assert.match(await guestSaid(guest), /Hello from the owner\./);
  assert.equal(
    await guest.evaluate(() => {
      const text = (root) =>
        [...root.querySelectorAll('*')]
          .map((element) => `${element.shadowRoot ? text(element.shadowRoot) : ''}`)
          .join(' ') + root.textContent;
      return /amazon-bedrock|us\.anthropic/.test(
        text(document.querySelector('slicc-chat').shadowRoot)
      );
    }),
    false,
    'the guest page shows the raw model id'
  );
  await owner.until(
    () => window.netPanel()?.querySelector('li[data-seat="s1"]')?.dataset.connected === 'true'
  );
  await shoot(owner, 'guests-connected', { show: 'network', target: 'section[data-guests]' });

  await guest.evaluate(() => {
    const { agent } = document.querySelector('slicc-chat').model;
    return agent.send(agent.active(), 'Hello from Anna');
  });
  const review = await owner.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.approvals.list()
      .find((item) => item.kind === 'guest-message')
  );
  assert.ok(!asked.some((body) => body.includes('Hello from Anna')), 'sent before the review');
  await owner.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'once'),
    review.id
  );
  await guest.until(() => {
    const { agent } = document.querySelector('slicc-chat').model;
    return JSON.stringify(agent.messages(agent.active())).includes('Nice to meet you, Anna.');
  });
  const delivered = asked.find((body) => body.includes('Hello from Anna'));
  assert.match(delivered, /A guest message from \\"Anna\\"/);
  assert.match(await transcript(owner), /Hello from Anna/);
  await shootGuest(guest, 'guest-chat');

  const probe = await guest.tab();
  await probe.goto('/os/join.html');
  await probe.until(
    (text) => document.querySelector('[data-seat-state]')?.textContent === text,
    REFUSED
  );
  await probe.evaluate(probeLink, hubSeat, 'probe');
  await probe.evaluate(probeLink, hubSeat, 'raw');
  await probe.until(
    () => window.probe.status().link === 'connected' && window.raw.status().link === 'connected'
  );
  const streams = await probe.evaluate(probeStreams);
  for (const [kind, code] of Object.entries(streams.refused))
    assert.equal(code, 'EOPNOTSUPP', `a guest link opened ${kind}`);
  assert.equal(streams.second, 'EBUSY');
  assert.notEqual(streams.owner, 'connected', 'a guest link reached the owner’s AgentControl');
  const wired = await probe.evaluate(rawWire);
  assert.deepEqual(wired.holds, {
    AgentControl: 'forbidden',
    AgentTranscript: 'forbidden',
    AgentSettings: 'forbidden',
    AgentRemoteService: 'forbidden',
    AgentPagesService: 'forbidden',
    AgentSudoService: 'forbidden',
    claimingOwner: 'forbidden',
  });
  assert.equal(wired.variant, 'guest');
  assert.equal(wired.open, 'forbidden');
  assert.equal(wired.revoke, 'forbidden');

  await owner.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Look around');
  });
  for (let i = 0; i < 600 && !holding; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.ok(holding, 'the owner’s run never asked the model');
  await guest.until(() => {
    const { agent } = document.querySelector('slicc-chat').model;
    return agent.busy(agent.active());
  });
  const coneState = () =>
    owner.evaluate(() =>
      JSON.stringify(
        document
          .querySelector('slicc-app')
          .model.agent.list()
          .map((a) => [a.id, a.name, a.model, a.kind])
      )
    );
  const agentsBefore = await coneState();
  const tried = await guest.evaluate(async () => {
    const { agent } = document.querySelector('slicc-chat').model;
    const id = agent.active();
    const outcome = async (fn) => {
      try {
        await fn();
        return 'accepted';
      } catch (error) {
        return error.message;
      }
    };
    agent.stop(id);
    return {
      createCone: await outcome(() => agent.createCone('Renamed by a guest')),
      drop: await outcome(() => agent.drop(id)),
      rewind: await outcome(() => agent.rewind(id, agent.messages(id).at(-1)?.id ?? 'x')),
      fired: [
        () => agent.clear(id),
        () => agent.createScoop(id, 'renamed'),
        () => agent.compact(id),
        () => agent.freeze(id),
        () => agent.setModel(id, 'amazon-bedrock/another-model'),
        () => agent.setThinking(id, 'high'),
      ].map((fire) => {
        try {
          fire();
          return 'fired';
        } catch (error) {
          return error.message;
        }
      }),
    };
  });
  for (const name of ['createCone', 'drop', 'rewind'])
    assert.match(tried[name], /a guest can only watch and send messages/, name);
  const proposed = await probe.evaluate(rawPropose, 'Not a steer');
  assert.equal(proposed.state, 'queued');
  const steer = await owner.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.approvals.list()
      .find((item) => item.kind === 'guest-message')
  );
  const forged = await probe.evaluate(rawForge, [cone.id, steer.id]);
  for (const [name, code] of Object.entries(forged))
    assert.equal(code, 'not_in_variant', `the owner’s agent took a guest’s ${name}: ${code}`);
  assert.ok(
    await owner.evaluate(
      (id) =>
        document
          .querySelector('slicc-app')
          .model.approvals.list()
          .some((item) => item.id === id),
      steer.id
    ),
    'a guest decided its own review'
  );
  assert.equal(
    await owner.evaluate(() => {
      const { agent } = document.querySelector('slicc-app').model;
      return agent.busy(agent.active());
    }),
    true,
    'a guest stopped or aborted the run'
  );
  assert.equal(await coneState(), agentsBefore);
  await owner.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'once'),
    steer.id
  );
  const inbox = () =>
    owner.evaluate(() => {
      const { agent } = document.querySelector('slicc-app').model;
      const id = agent.active();
      return {
        busy: agent.busy(id),
        queued: agent
          .queue(id)
          .filter((item) => item.origin === 'guest')
          .map((item) => ({ text: item.text, mode: item.mode })),
      };
    });
  await owner
    .within(60000, () => {
      const { agent } = document.querySelector('slicc-app').model;
      return agent
        .queue(agent.active())
        .some((item) => item.origin === 'guest' && item.text.includes('Not a steer'));
    })
    .catch(async (error) => {
      throw new Error(
        `the approved guest message never queued: ${error.message}\n${JSON.stringify(await inbox())}`
      );
    });
  assert.deepEqual(await inbox(), {
    busy: true,
    queued: [{ text: 'Not a steer', mode: 'queue' }],
  });
  release();
  await owner.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const said = JSON.stringify(agent.messages(agent.active()));
    return said.includes('Got the follow-up from Anna.') && !agent.busy(agent.active());
  });
  const toolRound = asked.find(
    (body) => body.includes('guest-look') && body.includes('toolResult')
  );
  assert.ok(toolRound, 'the run never sent its tool result');
  assert.ok(!toolRound.includes('Not a steer'), 'the guest’s message steered the run');
  assert.ok(!asked.some((body) => /raw guest/.test(body)), 'a forged call reached the model');
  assert.doesNotMatch(await transcript(owner), /raw guest/);
  const followed = JSON.parse(asked.find((body) => body.includes('Not a steer')));
  const [answered, last] = followed.messages.slice(-2);
  assert.equal(answered.role, 'assistant');
  assert.match(JSON.stringify(answered.content), /Done looking\./);
  assert.equal(last.role, 'user');
  assert.ok(!last.content.some((item) => item.toolResult), 'the guest’s message fed a tool round');
  assert.match(JSON.stringify(last.content), /Not a steer/);
  const order = await owner.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const list = agent.messages(agent.active());
    return {
      done: list.findIndex(
        (m) => m.role === 'assistant' && JSON.stringify(m).includes('Done looking.')
      ),
      guest: list.findIndex(
        (m) =>
          m.role === 'user' && m.origin === 'guest' && JSON.stringify(m).includes('Not a steer')
      ),
    };
  });
  assert.ok(
    order.done >= 0 && order.guest > order.done,
    `not a follow-up: ${JSON.stringify(order)}`
  );
  assert.equal(await coneState(), agentsBefore);
  assert.equal(
    await owner.evaluate(() => {
      const { agent } = document.querySelector('slicc-app').model;
      return agent.list().find((a) => a.id === agent.active()).name;
    }),
    cone.name
  );

  await owner.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Use sudo');
  });
  const sudo = await owner.within(120000, () =>
    document
      .querySelector('slicc-app')
      .model.approvals.list()
      .find((item) => item.kind === 'sudo')
  );
  assert.deepEqual(
    await guest.evaluate(() => {
      const { approvals } = document.querySelector('slicc-chat').model;
      return { list: approvals.list().length, decide: typeof approvals.decide };
    }),
    { list: 0, decide: 'undefined' }
  );
  assert.equal(
    await probe.evaluate((id) => window.wire.forge('decide', [id, 'always', null]), sudo.id),
    'not_in_variant'
  );
  assert.ok(
    await owner.evaluate(
      (id) =>
        document
          .querySelector('slicc-app')
          .model.approvals.list()
          .some((item) => item.id === id),
      sudo.id
    ),
    'a guest answered the cone’s sudo'
  );
  await owner.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'deny'),
    sudo.id
  );
  await owner.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active())).includes('Sudo answered.');
  });

  const follower = await guest.tab();
  await follower.init(deep);
  const { joinUrl } = await model(owner, (network) => network.status().links);
  await follower.goto(`/#follow=${encodeURIComponent(joinUrl)}`);
  await follower.until(
    () => !!window.deep('slicc-confirm')?.shadowRoot?.querySelector('dialog[open]')
  );
  await follower.evaluate(() =>
    [...window.deep('slicc-confirm').shadowRoot.querySelectorAll('swc-button')]
      .find((b) => b.textContent.trim() === 'Follow')
      .click()
  );
  const device = await owner.within(
    120000,
    () =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.find((d) => d.kind === 'seven' && d.asking && d.state === 'connected')?.id
  );
  await model(owner, (network, id) => network.setAccess(id, 'view', true), device);
  await follower.within(5 * 60 * 1000, () =>
    (document.querySelector('slicc-app').model.guests?.list() ?? []).some(
      (seat) => seat.id === 's1' && seat.label === 'Anna' && seat.connected
    )
  );
  await follower.evaluate(() => document.querySelector('slicc-app').show('network'));
  await follower.until(
    () => window.netPanel()?.querySelector('li[data-seat="s1"]')?.dataset.connected === 'true'
  );
  assert.deepEqual(
    await follower.evaluate(() => ({
      surfaces: document.querySelector('slicc-app').surfaces.map((s) => s.id),
      network: 'network' in document.querySelector('slicc-app').model,
      guests: !!window.netPanel().querySelector('section[data-guests]'),
      unavailable: window.netPanel().querySelector('[data-guests-unavailable]')?.textContent.trim(),
      invite: !!window.netPanel().querySelector('[data-action=invite-guest]'),
    })),
    {
      surfaces: ['agents', 'chat', 'terminal', 'network', 'settings'],
      network: false,
      guests: true,
      unavailable: 'Inviting guests needs the tray hub.',
      invite: false,
    }
  );

  await owner.evaluate(() =>
    window.netPanel().querySelector('li[data-seat="s1"] [data-action=revoke-guest]').click()
  );
  await owner.until(
    () => !!window.deep('slicc-confirm')?.shadowRoot?.querySelector('[data-action]')
  );
  const revokedAt = Date.now();
  await owner.evaluate(() =>
    window.deep('slicc-confirm').shadowRoot.querySelector('[data-action]').click()
  );
  await probe.within(
    5000,
    () => window.probe.status().link !== 'connected' && window.raw.status().link !== 'connected'
  );
  await guest.within(
    10000,
    (text) =>
      document.querySelector('[data-seat-state]')?.textContent === text &&
      document.querySelector('slicc-chat').hidden,
    REFUSED
  );
  const closedIn = Date.now() - revokedAt;
  await probe.within(
    60000,
    () => window.probe.status().link === 'failed' && window.raw.status().link === 'failed'
  );
  assert.equal(await guest.evaluate(() => sessionStorage.getItem('slicc-os.seat')), null);
  assert.equal(hub.seats.get('g1').revoked, true);
  await owner.until(() => !window.netPanel().querySelector('li[data-seat="s1"]'));
  assert.deepEqual(await seats(owner), []);
  await follower.until(
    () => !(document.querySelector('slicc-app').model.guests?.list() ?? []).length
  );
  assert.deepEqual(
    await owner.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.map((d) => [d.id, d.kind])
    ),
    [[device, 'seven']]
  );
  const stored = await owner.evaluate(() => ({ ...localStorage }));
  assert.ok(!JSON.stringify(stored).includes('/join/g1'), 'the owner kept the seat’s link');
  const denied = JSON.parse(stored['slicc-os.revoked-seats']);
  assert.deepEqual(Object.keys(denied), ['s1']);
  assert.ok(Math.abs(denied.s1 - minted.expiresAt) < 1000, `denied until ${denied.s1}`);

  const again = await guest.tab();
  await again.goto(`/${seatAt.hash}`);
  await again.within(
    5 * 60 * 1000,
    (text) => document.querySelector('[data-seat-state]')?.textContent === text,
    REFUSED
  );
  assert.equal(await again.evaluate(() => sessionStorage.getItem('slicc-os.seat')), null);
  t.diagnostic(`the guest's page showed the refusal ${closedIn} ms after Revoke`);

  const ben = await owner.evaluate(async (agentId) => {
    const { guests } = document.querySelector('slicc-app').model;
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const made = await guests.mint(agentId, {
      label: 'Ben',
      expiresAt,
      gates: { messages: 'user', tools: 'user' },
    });
    return { id: made.seat.id, url: made.url, expiresAt };
  }, cone.id);
  const benSeat = new URLSearchParams(new URL(ben.url).hash.slice(1)).get('seat');
  await probe.evaluate(probeLink, benSeat, 'ben');
  await probe.until(() => window.ben.status().link === 'connected');
  hub.failStops = true;
  const unstopped = await owner.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.guests.revoke(id)
        .then(
          () => 'revoked',
          (error) => error.message
        ),
    ben.id
  );
  assert.equal(
    unstopped,
    'Seven refuses this guest from now on, but the tray hub didn’t revoke the link: biscotto request failed'
  );
  assert.equal(hub.seats.get(new URL(benSeat).pathname.split('/').at(-1)).revoked, false);
  await probe.within(5000, () => window.ben.status().link !== 'connected');
  await probe.within(60000, () => window.ben.status().link === 'failed');
  assert.ok(
    hub.fromLeader.some(
      (m) =>
        m.type === 'bootstrap.failed' &&
        m.code === 'UNTRUSTED' &&
        m.message === 'this guest seat was revoked'
    ),
    'the hub let a revoked seat re-dial and seven took it'
  );
  assert.deepEqual(
    await owner.evaluate(
      (id) =>
        document
          .querySelector('slicc-app')
          .model.notices.list()
          .filter((notice) => notice.id === `guest-seat-stop:${id}`)
          .map((notice) => [notice.title, notice.body]),
      ben.id
    ),
    [['A revoked guest’s link is still on the tray hub', unstopped]]
  );
  const kept = await owner.evaluate(() =>
    JSON.parse(localStorage.getItem('slicc-os.revoked-seats'))
  );
  assert.ok(Math.abs(kept[ben.id] - ben.expiresAt) < 1000, `denied until ${kept[ben.id]}`);
  hub.failStops = false;

  for (const page of [owner, guest, follower, probe, again]) assert.deepEqual(page.errors, []);
});
