import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import {
  actPackage,
  agentState,
  agentUp,
  connectAccount,
  connected,
  listsAccount,
  ready,
  run,
  screen,
} from './bios.mjs';
import { launch } from './chrome.mjs';
import { leader, model, startHub } from './fake-hub.mjs';
import { eventFrame, fakeLlm } from './fake-llm.mjs';
import { PEER_TRACE, peerTrace } from './peer-trace.mjs';

const KEY = 'dummy-bedrock-key-0000';
const SECRET = 'dummy-secret-value-4242';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const STEP = 3 * 60 * 1000;
const answer = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the leader.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const sleeping = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockStart', {
    contentBlockIndex: 0,
    start: { toolUse: { toolUseId: 'sleep-1', name: 'bash' } },
  }),
  eventFrame('contentBlockDelta', {
    contentBlockIndex: 0,
    delta: { toolUse: { input: JSON.stringify({ command: 'sleep 600' }) } },
  }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'tool_use' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12 },
    metrics: { latencyMs: 1 },
  }),
]);

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

let sleeps = 0;

const leaders = await launch({ intercept: [], agent: true, timeout: 60000 });
const followers = await launch({ timeout: 60000 });
const asked = [];
const llm = await fakeLlm(leaders.cdp, {
  hosts: [BEDROCK, 'https://registry.npmjs.org/'],
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    asked.push(body.toString());
    const turn = lastTurn(body);
    const hold = turn.tools && turn.content.some((item) => item.text?.includes('Hold on'));
    if (hold) sleeps += 1;
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: hold ? sleeping : answer,
    };
  },
});
const hub = await startHub();
after(async () => {
  hub.close();
  await llm.close();
  await Promise.all([leaders.close(), followers.close()]);
});

async function shell(page) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.followClient ??= await globalThis.sliccKernelClient();
  });
}

const sh = (page, command) =>
  page.evaluate(
    (command) =>
      globalThis.followClient
        .run(['bash', '-c', command], { cwd: '/' })
        .then(({ status, stdout, stderr }) => ({ status, out: `${stdout ?? ''}${stderr ?? ''}` })),
    command
  );

async function typed(page, command, label, ms = STEP) {
  await run(page, `clear; ${command}; echo "${label}-$((40 + 2)) $?"`);
  const pattern = `${label}-42 (\\d+)`;
  const code = await page
    .within(
      ms,
      (pattern) => {
        const { dock } = document.querySelector('slicc-app');
        const id = dock.api.panels
          .map((panel) => panel.id)
          .findLast((id) => id.startsWith('terminal:'));
        return new RegExp(pattern).exec(dock.content(id).screen.textContent)?.[1];
      },
      pattern
    )
    .catch(async (error) => {
      throw new Error(
        `${label}: ${error.message}\nscreen:\n${await screen(page)}\nconsole:\n${page.console.slice(-15).join('\n')}`
      );
    });
  return { code: Number(code), text: await screen(page) };
}

const devices = (page) => model(page, (network) => network.status().links.devices);

async function device(page, known, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = (await devices(page)).find(
      (item) => item.kind === 'cli' && item.mode === 'remote' && !known.includes(item.id)
    );
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`no new linked device on the leader: ${JSON.stringify(await devices(page))}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function file(page, path, wanted, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { out } = await sh(page, `cat ${path} 2>/dev/null; true`);
    if (wanted.test(out)) return out;
    if (Date.now() > deadline) throw new Error(`${path} never matched ${wanted}:\n${out}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function logged(page, wanted, ms = 60000) {
  const read = () =>
    page.evaluate(async () => {
      let dir = await navigator.storage.getDirectory();
      try {
        for (const part of ['var', 'log', 'slicc']) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle('denials.log')).getFile()).text();
      } catch {
        return '';
      }
    });
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await read();
    if (wanted.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`denials.log never matched ${wanted}:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const events = (text) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));

const certificate = (page, hubUrl) =>
  page.evaluate(
    (key) =>
      new Promise((resolve, reject) => {
        const opening = indexedDB.open('slicc-follow', 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore('certificates');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const get = db.transaction('certificates').objectStore('certificates').get(key);
          get.onsuccess = () => {
            db.close();
            resolve(get.result ? 'kept' : 'none');
          };
          get.onerror = () => reject(get.error);
        };
      }),
    `link:${hubUrl}`
  );

const followed = (page) =>
  page.evaluate(() => {
    const text = localStorage.getItem('slicc-os.leaders') ?? '{}';
    return { text, keys: Object.keys(JSON.parse(text)) };
  });

test('in seven’s terminal a cone’s slicc prompts, watches and aborts another seven’s agent, which must allow it; forged, unlinked and scoop callers are refused, the leader can open nothing, and the join URL is never logged', {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const owner = await leaders.page(t);
  await owner.init(PEER_TRACE);
  await owner.goto('/');
  await ready(owner);
  await owner.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await owner.reload();
  await ready(owner);
  const page = await followers.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.init(PEER_TRACE);
  await page.goto('/');
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  const install = async () => {
    await page.within(5 * 60 * 1000, () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'slicc' && item.state === 'available')
    );
    return actPackage(page, 'slicc');
  };
  const [installed] = await Promise.all([install(), agentUp(owner, { label: 'leader agent' })]);
  assert.equal(installed, 'ok');
  await listsAccount(owner, 'amazon-bedrock');
  await connectAccount(owner, 'amazon-bedrock', KEY);
  await connected(owner, 'amazon-bedrock');
  await shell(page);
  const { joinUrl } = await model(owner, (network) => network.status().links);
  assert.match(joinUrl, /\/join\/j\d+$/);
  const token = new URL(joinUrl).pathname;
  assert.equal(
    (await sh(page, 'sudo -u cone printenv SLICC_LINK_URL')).out.trim(),
    'tcp://127.0.0.1:7400'
  );

  const first = await typed(page, `sudo -u cone slicc '${joinUrl}' prompt "Say hello"`, 'refused');
  assert.equal(
    first.code,
    3,
    `${first.text}\n${await peerTrace({ leader: owner, follower: page })}`
  );
  assert.match(first.text, /doesn't allow remote control from this one/);
  const linked = await device(owner, []);
  assert.equal(linked.name, `seven on ${new URL(followers.url).host}`);
  assert.equal(linked.control.allowed, false);
  assert.equal(await certificate(page, hub.url), 'kept');
  const before = asked.length;
  assert.ok(!asked.some((body) => body.includes('Say hello')));
  await model(owner, (network, id) => network.setRemoteControl(id, true), linked.id);

  await run(
    page,
    `clear; sudo -u cone slicc '${joinUrl}' watch --json > /tmp/watch.json 2> /tmp/watch.err & echo $! > /tmp/watch.pid`
  );
  await owner
    .within(STEP, () =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.some((item) => item.controlling === 'watch')
    )
    .catch(async (error) => {
      const { out } = await sh(page, 'cat /tmp/watch.err');
      throw new Error(
        `the watch never reached the leader: ${error.message}\n${out}\n${JSON.stringify(await devices(owner))}`
      );
    });

  const prompted = await typed(
    page,
    `sudo -u cone slicc '${joinUrl}' prompt "Say hello"`,
    'prompted'
  );
  if (prompted.code !== 0)
    assert.fail(
      `slicc prompt exited ${prompted.code}:\n${prompted.text}\n${await agentState(owner)}`
    );
  assert.match(prompted.text, /Hello from the leader\./);
  assert.ok(asked.slice(before).some((body) => body.includes('Say hello')));
  const watched = events(await file(page, '/tmp/watch.json', /the leader\./));
  const said = watched.find((event) => event.t === 'user');
  assert.equal(said?.text, 'Say hello');
  assert.match(
    watched
      .filter((event) => event.t === 'text')
      .map((event) => event.delta)
      .join(''),
    /Hello from the leader\./
  );

  await page.evaluate(
    (secret) => document.querySelector('slicc-app').model.vault.put('FOLLOW_TOKEN', secret),
    SECRET
  );
  await page.within(60000, () => {
    const raw = localStorage.getItem('slicc-os.vault-scrub');
    return raw && JSON.parse(raw).needed === true;
  });
  const scrubbed = await typed(
    page,
    `sudo -u cone slicc '${joinUrl}' prompt "Keep ${SECRET} marker-77"`,
    'scrubbed'
  );
  assert.equal(scrubbed.code, 0, scrubbed.text);
  const kept = asked.filter((body) => body.includes('marker-77'));
  assert.ok(kept.length > 0, 'the scrubbed prompt reached the leader’s model');
  assert.ok(kept.every((body) => !body.includes(SECRET) && body.includes('fnox_proxy_')));

  await run(
    page,
    `clear; (sudo -u cone slicc '${joinUrl}' prompt "Hold on" > /tmp/held.out 2>&1; echo "held=$?" >> /tmp/held.out) &`
  );
  const sleep = events(await file(page, '/tmp/watch.json', /sleep 600/, STEP)).find(
    (event) => event.t === 'tool' && /sleep 600/.test(event.summary)
  );
  assert.ok(sleep, 'the held prompt’s tool call reached the watch');
  assert.equal(sleeps, 1);
  const aborted = await typed(page, `sudo -u cone slicc '${joinUrl}' abort`, 'aborted');
  assert.equal(aborted.code, 0, aborted.text);
  assert.match(aborted.text, /aborted the run/);
  const heldOut = await file(page, '/tmp/held.out', /held=\d+/);
  assert.match(heldOut, /held=1/);
  assert.match(heldOut, /the run was aborted/);
  assert.ok(
    events(await file(page, '/tmp/watch.json', /Hold on/)).some(
      (event) => event.t === 'user' && event.text === 'Hold on'
    )
  );
  await sh(page, 'kill $(cat /tmp/watch.pid)');
  await owner
    .within(60000, () =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.every((item) => !item.controlling)
    )
    .catch(async (error) => {
      throw new Error(
        `the leader still shows the killed watch: ${error.message}\n${JSON.stringify(await devices(owner))}\n${(await sh(page, 'cat /tmp/watch.err')).out}`
      );
    });

  const forged = await typed(page, `sudo -u cone slicc '${hub.url}/join/j999' prompt hi`, 'forged');
  assert.equal(forged.code, 3, forged.text);
  assert.match(forged.text, /the tray hub doesn't know that join URL/);
  const elsewhere = await typed(
    page,
    "sudo -u cone slicc 'https://hub.example/join/abc' watch",
    'elsewhere'
  );
  assert.equal(elsewhere.code, 3, elsewhere.text);
  assert.match(elsewhere.text, /isn't on a tray hub this seven links through/);

  const made = await sh(
    page,
    "echo 'scoop-probe:x:1100:1100:scoop-probe:/home/cone:/bin/bash' >> /etc/passwd && echo 'scoop-probe:x:1100:' >> /etc/group && sed -i 's/^cone:x:1000:$/cone:x:1000:scoop-probe/' /etc/group && sudo -u scoop-probe id"
  );
  assert.match(made.out, /uid=1100\(scoop-probe\).*1000\(cone\)/, made.out);
  assert.doesNotMatch(made.out, /sudo/);
  const scoop = await typed(page, `sudo -u scoop-probe slicc '${joinUrl}' watch`, 'scoop');
  assert.equal(scoop.code, 3, scoop.text);
  assert.match(scoop.text, /only root and members of sudo may reach another seven/);
  const denials = await logged(page, /"user":"scoop-probe"/);
  const denial = denials
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.user === 'scoop-probe' && entry.op === 'connect');
  assert.deepEqual([denial?.path, denial?.errno], ['tcp://127.0.0.1:7400', 'EACCES']);

  const fake = await owner.evaluate(leader, hub.url);
  await run(
    page,
    `clear; F='${fake}'; sudo -u cone slicc "$F" watch --json > /tmp/fake.json 2>&1 & echo $! > /tmp/fake.pid`
  );
  await owner
    .within(STEP, () => globalThis.fakeLeader.opens.length > 0)
    .catch(async (error) => {
      throw new Error(
        `the fake leader was never followed: ${error.message}\n${(await sh(page, 'cat /tmp/fake.json')).out}`
      );
    });
  const seen = await owner.evaluate(() => ({
    ...globalThis.fakeLeader,
    open: undefined,
    unlink: undefined,
  }));
  assert.deepEqual(seen.runtimes, ['slicc-link/1']);
  assert.deepEqual([seen.hello.role, seen.hello.mode, seen.hello.caps], ['node', 'remote', []]);
  assert.deepEqual(seen.opens, [{ kind: 'agent', op: 'watch' }]);
  const refusedStreams = await owner.evaluate(async (url) => {
    const out = [];
    for (const meta of [
      { kind: 'unlink' },
      { kind: 'join', url },
      { kind: 'agent', op: 'watch' },
      { kind: 'kernel', port: 22 },
    ])
      out.push(await globalThis.fakeLeader.open(meta));
    return out;
  }, fake);
  assert.deepEqual(refusedStreams, ['EACCES', 'EACCES', 'EACCES', 'EACCES']);
  assert.equal(await certificate(page, hub.url), 'kept');
  assert.equal((await followed(page)).keys.length, 2);
  await sh(page, 'kill $(cat /tmp/fake.pid)');
  assert.deepEqual(
    await owner.within(
      60000,
      () => globalThis.fakeLeader.resets.length && globalThis.fakeLeader.resets
    ),
    ['ECONNRESET']
  );

  await model(owner, (network, id) => network.unlink(id), linked.id);
  const unlinked = await typed(
    page,
    `sudo -u cone slicc '${joinUrl}' prompt "After the unlink"`,
    'unlinked'
  );
  assert.equal(unlinked.code, 3, unlinked.text);
  assert.match(unlinked.text, /unlinked this one/);
  assert.equal(await certificate(page, hub.url), 'kept');
  const marked = Object.values(JSON.parse((await followed(page)).text));
  assert.deepEqual(
    marked.map((item) => item.unlinked === true).sort(),
    [false, true],
    'only the unlinking leader’s record is marked; the fake leader’s stays'
  );
  assert.ok(!asked.some((body) => body.includes('After the unlink')));
  const again = await typed(page, `sudo -u cone slicc '${joinUrl}' abort`, 'relinked');
  assert.equal(again.code, 3, again.text);
  assert.match(again.text, /doesn't allow remote control from this one/);
  const fresh = await device(owner, [linked.id]);
  assert.notEqual(fresh.id, linked.id);

  const state = Object.values(JSON.parse((await followed(page)).text));
  assert.ok(
    state.every((item) => item.url === undefined || [joinUrl, fake].includes(item.url)),
    'a leader record keeps only its own join URL'
  );
  const shown = await model(page, (network) => network.status().leaders);
  assert.equal(shown.length, 2);
  const logs = [
    ...page.console,
    ...owner.console,
    ...page.errors,
    ...owner.errors,
    denials,
    JSON.stringify(shown),
    await logged(page, /./),
    (await sh(page, 'cat /tmp/watch.err /tmp/fake.json 2>/dev/null; true')).out,
  ].join('\n');
  for (const secret of [joinUrl, token, new URL(fake).pathname])
    assert.ok(!logs.includes(secret), secret);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(owner.errors, []);
});
