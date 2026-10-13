import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const INSTALL = 15 * 60 * 1000;
const BUILD = `l=$(printf '%0240d' 0); for i in $(seq 1 2400); do echo "dummy build line $i $l"; done; exit 3`;
const WORKERS = 'for i in $(seq 1 40); do sleep 900 > /dev/null 2>&1 & done; echo started';

const usage = eventFrame('metadata', {
  usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
  metrics: { latencyMs: 1 },
});
const text = (said) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: said } }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'end_turn' }),
    usage,
  ]);
const bash = (id, command) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockStart', {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: id, name: 'bash' } },
    }),
    eventFrame('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: { toolUse: { input: JSON.stringify({ command }) } },
    }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'tool_use' }),
    usage,
  ]);

const turn = (body) => {
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

function answer(body) {
  const { tools, content } = turn(body);
  const said = content.map((item) => item.text ?? '').join(' ');
  const result = content.find((item) => item.toolResult)?.toolResult?.toolUseId;
  if (result === 'build-1')
    return text('The build failed with exit status 3; the full log is saved.');
  if (result === 'workers-1') return text('Started 40 workers.');
  if (tools && said.includes('Run the build')) return bash('build-1', BUILD);
  if (tools && said.includes('Start the workers')) return bash('workers-1', WORKERS);
  if (content.some((item) => item.image)) return text('A blue square.');
  return text('Done.');
}

const chrome = await launch({ agent: true, timeout: 60000 });
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: answer(body),
    };
  },
});
after(async () => {
  await proxy.close();
  await chrome.close();
});

const settled = (page, needle) =>
  page.until((needle) => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id) && JSON.stringify(agent.messages(id)).includes(needle);
  }, needle);

const quiet = (page) =>
  page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });

const deep = `(selector) => {
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
}`;

test("the agent's UI on slicc-agent 3.48 and spectrum 1.67: a failed bash card with notes, the Monitor at warn, the drop overlay, a sent image, Secrets and Changes without a repository", {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await page.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.settings?.accounts?.()
      .some((a) => a.id === 'amazon-bedrock')
  );
  await page.evaluate(
    (secret) =>
      document.querySelector('slicc-app').model.settings.connect('amazon-bedrock', secret),
    KEY
  );
  await quiet(page);

  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Run the build');
  });
  await settled(page, 'The build failed');
  const card = await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const tools = agent
      .messages(agent.active())
      .flatMap((message) => (message.role === 'assistant' ? message.parts : []))
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool);
    const failed = tools.find((tool) => tool.name === 'bash' && tool.status === 'error');
    return failed ? { notes: (failed.notes ?? []).map((note) => note.text) } : null;
  });
  assert.ok(card, 'the bash card failed');
  assert.ok(
    card.notes.some((note) => /Output truncated/.test(note)),
    card.notes.join('\n')
  );
  await quiet(page);
  await shoot(page, 'failed-bash-card', {
    show: 'chat',
    before: new Function(`
      const card = (${deep})('details.tool[data-status="error"]');
      if (card) {
        card.open = true;
        card.querySelector('.notes')?.scrollIntoView({ block: 'center' });
      }
    `),
  });

  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Start the workers');
  });
  await settled(page, 'Started 40 workers');
  await page.evaluate(() => document.querySelector('slicc-app').show('monitor'));
  const alert = await page
    .within(120000, () =>
      document
        .querySelector('slicc-app')
        .model.monitor.snapshot()
        .alerts.find((item) => item.command?.startsWith('kill -- -'))
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => {
        const snapshot = document.querySelector('slicc-app').model.monitor.snapshot();
        return JSON.stringify({
          alerts: snapshot.alerts,
          processes: snapshot.sections.find((item) => item.id === 'processes')?.rows.slice(0, 6),
        });
      });
      throw new Error(`no crowd alert: ${seen}`, { cause: error });
    });
  assert.equal(alert.severity, 'warn');
  await quiet(page);
  await shoot(page, 'monitor-warn', { show: 'monitor' });
  await page.evaluate(() => document.querySelector('slicc-app').show('terminal'));
  await run(page, alert.command);
  await page.evaluate(() => document.querySelector('slicc-app').show('monitor'));
  await page.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.monitor.snapshot()
      .alerts.every((item) => !item.command?.startsWith('kill -- -'))
  );
  await page.evaluate(() => document.querySelector('slicc-app').dock.close('monitor'));

  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(96, 96);
    const context = canvas.getContext('2d');
    context.fillStyle = '#2d6cdf';
    context.fillRect(0, 0, 96, 96);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    window.square = new File([blob], 'square.png', { type: 'image/png' });
  });
  const drag = new Function(`
    const chat = (${deep})('slicc-chat');
    const data = new DataTransfer();
    data.items.add(window.square);
    chat.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, composed: true, cancelable: true }));
  `);
  await page.evaluate(drag);
  await page.until(new Function(`return !!(${deep})('swc-dropzone[dragged]')`));
  await quiet(page);
  await shoot(page, 'drop-to-attach', { show: 'chat', before: drag });
  await page.evaluate(
    new Function(`
    const chat = (${deep})('slicc-chat');
    chat.dispatchEvent(new DragEvent('dragleave', { relatedTarget: null, bubbles: true, composed: true }));
  `)
  );

  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const url = URL.createObjectURL(window.square);
    void agent.send(agent.active(), {
      text: 'What is in this picture?',
      attachments: [
        {
          id: 'square',
          name: 'square.png',
          kind: 'image',
          mimeType: 'image/png',
          size: window.square.size,
          url,
        },
      ],
    });
  });
  await settled(page, 'A blue square.');
  await quiet(page);
  await shoot(page, 'sent-image', { show: 'chat' });

  await page.evaluate(async () => {
    const at = new URL(
      '../node_modules/@ai-ecoverse/slicc-spectrum/dist/slicc-dummy.js',
      location.href
    );
    const { DummyVault } = await import(at.href);
    const app = document.querySelector('slicc-app');
    app.model = {
      ...app.model,
      vault: new DummyVault('secrets', { delay: 0, sleep: async () => {} }),
    };
  });
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(new Function(`return !!(${deep})('slicc-secrets')`));
  await quiet(page);
  await shoot(page, 'settings-secrets', { show: 'settings', target: 'slicc-secrets' });

  await page.evaluate(() => document.querySelector('slicc-app').show('terminal'));
  await run(
    page,
    "printf '#!/bin/sh\\nexit 1\\n' > /usr/local/bin/git && chmod +x /usr/local/bin/git && touch /home/notes.txt"
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('changes'));
  await page.within(
    120000,
    new Function(`
      const box = (${deep})('[data-unavailable]');
      return !!box && /there are none here yet/.test(box.textContent) && !!box.parentElement.querySelector('[data-command^="curl -fsSL https://get.sliccy.ai/slicc"] [data-action="copy-command"]');
    `)
  );
  await quiet(page);
  await shoot(page, 'changes-no-repo', { show: 'changes' });

  assert.deepEqual(page.errors, []);
});
