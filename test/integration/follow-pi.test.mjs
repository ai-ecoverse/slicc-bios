import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { connectAccount, ready, trust } from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const ADOBE = 'https://adobe-llm-proxy.paolo-moz.workers.dev/';
const ADOBE_TOKEN = 'dummy-adobe-token-0000';
const adobe = {
  config: { clientId: 'test-client', scopes: 'openid,AdobeID', imsEnvironment: 'prod', models: [] },
  usage: { usage: { weekly: { status: 'ok', percent: 42, resetsAt: '2026-10-15T00:00:00Z' } } },
};
const INSTALL = 15 * 60 * 1000;
const reply = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the owner.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const looking = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', {
    contentBlockIndex: 0,
    delta: { text: 'Let me look around this SLICC first.' },
  }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('contentBlockStart', {
    contentBlockIndex: 1,
    start: { toolUse: { toolUseId: 'look-1', name: 'bash' } },
  }),
  eventFrame('contentBlockDelta', {
    contentBlockIndex: 1,
    delta: { toolUse: { input: JSON.stringify({ command: 'ls /' }) } },
  }),
  eventFrame('contentBlockStop', { contentBlockIndex: 1 }),
  eventFrame('messageStop', { stopReason: 'tool_use' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12 },
    metrics: { latencyMs: 1 },
  }),
]);
let release = null;
const held = new Promise((resolve) => {
  release = resolve;
});
let holding = false;
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

const owners = await launch({ agent: true, timeout: 60000 });
const followers = await launch({
  agent: true,
  timeout: 60000,
  args: ['--disable-features=IsolateSandboxedIframes'],
});
const asked = [];
const proxy = await fakeProxy({
  origin: new URL(owners.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (request.url.startsWith(ADOBE))
      return {
        status: 200,
        headers: [['content-type', 'application/json']],
        body: Buffer.from(
          JSON.stringify(request.url.endsWith('/v1/config') ? adobe.config : adobe.usage)
        ),
      };
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    asked.push(body.toString());
    const turn = lastTurn(body);
    if (turn.tools && turn.content.some((item) => item.text?.includes('Say hello')))
      return {
        status: 200,
        headers: [['content-type', 'application/vnd.amazon.eventstream']],
        body: looking,
      };
    if (turn.content.some((item) => item.toolResult) && !holding) {
      holding = true;
      await held;
    }
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: reply,
    };
  },
});
after(async () => {
  await proxy.close();
  await Promise.all([owners.close(), followers.close()]);
});

const dialog = () => {
  const deep = (root) => {
    const found = root.querySelector('slicc-confirm');
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && deep(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return deep(document)?.shadowRoot?.querySelector('dialog[open]') ?? null;
};

async function inFrames(page, fn) {
  const { frameTree } = await page.send('Page.getFrameTree');
  const frames = [];
  const walk = (node) => {
    for (const child of node.childFrames ?? []) {
      frames.push(child.frame.id);
      walk(child);
    }
  };
  walk(frameTree);
  const results = [];
  for (const frameId of frames) {
    const world = await page
      .send('Page.createIsolatedWorld', { frameId, worldName: 'follow-pi' })
      .catch(() => null);
    if (!world) continue;
    const { result } = await page.send('Runtime.evaluate', {
      contextId: world.executionContextId,
      expression: `(${fn})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    results.push(result?.value);
  }
  return results;
}

const owned = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify({
      agents: agent.list().map((a) => [a.id, a.kind, !!a.frozen]),
      frozen: agent.frozen().length,
      messages: agent.messages(agent.active()).filter((message) => message.kind !== 'notice')
        .length,
      busy: agent.busy(agent.active()),
      queue: agent.queue(agent.active()).length,
    });
  });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const notices = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent
      .messages(agent.active())
      .filter((message) => message.kind === 'notice')
      .map((message) => message.text);
  });

async function refusedOnly(page, from, at = 1) {
  for (let i = 0; i < 100 && (await notices(page)).length < from + at; i += 1) await pause(100);
  await pause(2000);
  const refusals = (await notices(page)).slice(from);
  assert.equal(refusals.length, at, `expected ${at} refusals, saw: ${refusals.join('\n')}`);
  for (const refusal of refusals) assert.match(refusal, /^This page is view-only, so it can't /);
}

const said = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent ? JSON.stringify(agent.messages(agent.active())) : '';
  });

test('a follower watches the owner run with View, is refused a send, and sends with Control', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await owners.page(t);
  await owner.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(owner);
  await owner.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await owner.reload();
  await ready(owner);
  await owner.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.settings?.accounts?.()
      .some((a) => a.id === 'amazon-bedrock')
  );
  await connectAccount(owner, 'amazon-bedrock', KEY);
  await connectAccount(owner, 'adobe', ADOBE_TOKEN);
  const { joinUrl } = await model(owner, (network) => network.status().links);

  const page = await followers.page(t);
  await page.goto(`/#follow=${encodeURIComponent(joinUrl)}`);
  await page.until(new Function(`return !!(${dialog})()`));
  await page.evaluate(
    new Function(
      `[...(${dialog})().getRootNode().host.shadowRoot.querySelectorAll('swc-button')].find((b) => b.textContent.trim() === 'Follow').click()`
    )
  );
  await page.until(
    () => document.querySelector('slicc-app')?.model?.follow?.state().link === 'connected'
  );
  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.kind === 'seven' && d.asking)
  );
  const [device] = await model(owner, (network) => network.status().links.devices);
  await model(owner, (network, id) => network.setAccess(id, 'view', true), device.id);
  await owner.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.controlling === 'watch')
  );

  await owner.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Say hello');
  });
  for (let i = 0; i < 600 && !holding; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(holding, 'the owner agent never ran its tool');
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const said = JSON.stringify(agent.messages(agent.active()));
    return said.includes('look around this SLICC') && agent.busy(agent.active());
  });
  await shoot(page, 'follower-chat-mid-answer', { show: 'chat' });

  const turning = await owned(owner);
  assert.equal(JSON.parse(turning).busy, true);
  const turnNotices = (await notices(page)).length;
  const steered = await page.evaluate(async () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    const outcome = (sent) =>
      sent.then(
        () => 'accepted',
        (error) => error.message
      );
    const steer = await outcome(agent.send(id, 'Steer from a watcher'));
    const queue = await outcome(agent.send(id, { text: 'Queued from a watcher', mode: 'queue' }));
    agent.stop(id);
    return { steer, queue };
  });
  assert.match(steered.steer, /watch, but not send/);
  assert.match(steered.queue, /watch, but not send/);
  await refusedOnly(page, turnNotices);
  assert.equal(await owned(owner), turning);
  assert.ok(!asked.some((body) => /from a watcher/.test(body)));
  release();
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active())).includes('Hello from the owner.');
  });
  assert.match(await said(page), /Say hello/);
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return !agent.busy(agent.active());
  });
  await shoot(page, 'follower-chat-answered', { show: 'chat' });
  await owner.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });
  await shoot(owner, 'owner-watching', { show: 'network', target: '[aria-labelledby="links"]' });
  await page.until(
    () => document.querySelector('slicc-app').model.tray.status().budget?.percent === 42
  );
  const tray = await page.evaluate(() => {
    const status = document.querySelector('slicc-app').model.tray.status();
    const deep = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-tray') return element;
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const chip = deep(document)?.shadowRoot?.querySelector('#chip');
    return { ...status, chip: chip?.getAttribute('aria-label') ?? null };
  });
  assert.deepEqual(
    [tray.role, tray.connection, tray.joinUrl, tray.followers],
    ['follower', 'live', '', []]
  );
  assert.equal(tray.budget.percent, 42);
  assert.match(tray.chip, new RegExp(`^Tray ${tray.name}: Live, 0 followers$`));
  await shoot(page, 'follower-tray', { show: 'chat' });
  await shoot(page, 'follower-tray-leave', {
    show: 'chat',
    before: () => {
      const deep = (root) => {
        for (const element of root.querySelectorAll('*')) {
          if (element.localName === 'slicc-follow' && !element.hasAttribute('page')) return element;
          const inner = element.shadowRoot && deep(element.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const popover = deep(document)?.shadowRoot?.querySelector('swc-popover');
      if (popover && !popover.open) popover.open = true;
    },
  });
  await page.evaluate(() => {
    const deep = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-follow' && !element.hasAttribute('page')) return element;
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const popover = deep(document)?.shadowRoot?.querySelector('swc-popover');
    if (popover) popover.open = false;
  });

  const ownerBefore = await owned(owner);
  const followerBefore = await owned(page);
  const askedBefore = asked.length;
  const noticesBefore = (await notices(page)).length;
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  let picked = [];
  for (let i = 0; i < 60 && !picked.includes('picked'); i += 1) {
    picked = await inFrames(page, () => {
      const work = [...document.querySelectorAll('#purposePills .pill')].find(
        (pill) => pill.textContent.trim() === 'Work'
      );
      if (!work) return 'none';
      work.click();
      return 'picked';
    });
    if (!picked.includes('picked')) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(picked.includes('picked'), `no Welcome choice to pick: ${picked}`);
  await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.sprinkles.send('welcome', { action: 'onboarding-complete', data: { purpose: 'work' } })
  );
  const deleteButton = new Function(`
    const deep = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-agents') return element;
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const agents = deep(document);
    return agents ? !!agents.shadowRoot?.querySelector('[data-action="delete-cone"]') : null;
  `);
  await page.until(new Function(`return (${deleteButton})() === false`));
  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    agent.freeze(agent.active());
  });
  await refusedOnly(page, noticesBefore, 2);
  assert.equal(await owned(owner), ownerBefore);
  assert.equal(await owned(page), followerBefore);
  assert.equal(asked.length, askedBefore);

  const sweepNotices = (await notices(page)).length;
  const ownerIdle = await owned(owner);
  const accounts = () =>
    owner.evaluate(() =>
      JSON.stringify(document.querySelector('slicc-app').model.settings.accounts())
    );
  const accountsBefore = await accounts();
  const swept = await page.evaluate(async () => {
    const { agent, settings, sprinkles } = document.querySelector('slicc-app').model;
    const id = agent.active();
    const last = agent.messages(id).at(-1)?.id ?? 'none';
    const outcome = (fn) => {
      try {
        return Promise.resolve(fn()).then(
          () => 'accepted',
          (error) => error.message
        );
      } catch (error) {
        return Promise.resolve(error.message);
      }
    };
    const awaited = {
      send: await outcome(() => agent.send(id, 'Prompt from a watcher')),
      rewind: await outcome(() => agent.rewind?.(id, last)),
      drop: await outcome(() => agent.drop?.(id)),
      createCone: await outcome(() => agent.createCone?.('From a watcher')),
      connect: await outcome(() => settings.connect('amazon-bedrock', 'dummy-other-key-0000')),
      call: await outcome(() => sprinkles.call('welcome', 'getState', [])),
    };
    const fired = [
      () => agent.compact(id),
      () => agent.stop(id),
      () => agent.clear(id),
      () => agent.setModel(id, 'amazon-bedrock/another-model'),
      () => agent.freeze?.(id),
      () => sprinkles.send('welcome', { action: 'onboarding-complete', data: {} }),
      () => settings.disconnect('amazon-bedrock'),
    ];
    for (const fire of fired) fire();
    return { awaited, fired: fired.length };
  });
  for (const [name, message] of Object.entries(swept.awaited))
    assert.match(message, /watch, but not send/, `${name}: ${message}`);
  await refusedOnly(page, sweepNotices, swept.fired);
  assert.equal(await owned(owner), ownerIdle);
  assert.equal(await accounts(), accountsBefore);
  assert.equal(asked.length, askedBefore);
  assert.doesNotMatch(await said(owner), /from a watcher/i);

  const refused = await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent.send(agent.active(), 'From a watcher').then(
      () => 'sent',
      (error) => error.message
    );
  });
  assert.match(refused, /EACCES|watch, but not send/);
  assert.ok(!asked.some((body) => body.includes('From a watcher')));
  assert.doesNotMatch(await said(owner), /From a watcher/);

  await model(owner, (network, id) => network.setAccess(id, 'control', true), device.id);
  await page.until(() => {
    const app = document.querySelector('slicc-app');
    return app.model.follow.state().access.control && !!app.model.agent;
  });
  await page.until(async () => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent.send(agent.active(), 'From the follower').then(
      () => true,
      () => false
    );
  });
  await owner.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active())).includes('From the follower');
  });
  await owner.until(
    () =>
      !document
        .querySelector('slicc-app')
        .model.agent.busy(document.querySelector('slicc-app').model.agent.active())
  );
  assert.ok(asked.some((body) => body.includes('From the follower')));
  assert.deepEqual(owner.errors, []);
  assert.deepEqual(page.errors, []);

  const file = await owner.evaluate(async () => {
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        const path = `${prefix}${name}`;
        if (handle.kind === 'file' && path.endsWith('@ai-ecoverse/slicc-agent/dist/link.js'))
          return { path, text: await (await handle.getFile()).text() };
        if (handle.kind === 'directory' && /^(opt|opt\/agent|.*node_modules.*)$/.test(path)) {
          const found = await walk(handle, `${path}/`);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(await navigator.storage.getDirectory(), '');
  });
  assert.ok(file, 'the owner has the agent installed');
  const newer = file.text.replace(
    'new TextEncoder().encode(frame.hello)',
    'new TextEncoder().encode(frame.hello.replace(/^slicc-agent-link\\/\\d+ /, "slicc-agent-link/9 "))'
  );
  assert.notEqual(newer, file.text);
  await trust(owner, { [file.path]: newer });
  await owner.reload();
  await ready(owner);
  await page.evaluate(() => {
    window.followWarnings = 0;
    const warn = console.warn;
    console.warn = (...args) => {
      if (String(args[0]).startsWith('following the agent')) window.followWarnings += 1;
      warn.apply(console, args);
    };
  });
  const banner = await page.within(5 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      .model.notices?.list()
      .find((item) => item.id === 'agent-mismatch')
  );
  assert.equal(banner.dismissible, false);
  assert.equal(banner.title, "This tab can't follow that SLICC");
  assert.equal(
    await page.evaluate(() => document.querySelector('slicc-app').model.agent.readOnly?.()),
    'Watch only.'
  );
  const before = await owned(owner);
  const sent = await page.evaluate(async () => {
    const { agent } = document.querySelector('slicc-app').model;
    window.firstAgent = agent;
    window.followWarnings = 0;
    return agent.send(agent.active(), 'From a mismatched follower').then(
      () => 'sent',
      (error) => error.code ?? error.message
    );
  });
  assert.equal(sent, 'EPROTO');
  await pause(10000);
  const after = await page.evaluate(() => {
    const { agent, notices } = document.querySelector('slicc-app').model;
    return {
      same: agent === window.firstAgent,
      banners: notices.list().filter((item) => item.id === 'agent-mismatch').length,
      warnings: window.followWarnings,
    };
  });
  assert.deepEqual(after, { same: true, banners: 1, warnings: 0 });
  assert.equal(await owned(owner), before);
  assert.ok(!asked.some((body) => body.includes('From a mismatched follower')));
  await shoot(page, 'follower-watch-only', { show: 'chat' });
  await owner.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
