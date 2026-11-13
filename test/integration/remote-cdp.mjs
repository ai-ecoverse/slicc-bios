import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { CLI, cliEnv } from './cli.mjs';

export const NO_GRANT =
  "browser control from this device is off; turn on Browser for it in seven's Linked devices";
export const SWITCHED_OFF = "browser control from linked devices is off in seven's settings";
export const STOPPED = 'stopped in seven';

export const escaped = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export async function within(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} unanswered after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const items = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.live.items()
      .filter((item) => item.kind === 'cdp')
      .map(({ id, kind, label, what, asker, action }) => ({ id, kind, label, what, asker, action }))
  );

export const setSwitch = (page, value) =>
  page.evaluate(
    (value) => document.querySelector('slicc-app').model.switches.set('remote-browser', value),
    value
  );

export const stopChip = (page, id) =>
  page.evaluate((id) => document.querySelector('slicc-app').model.live.act(id), id);

export async function scratch(t, prefix = 'remote-cdp-') {
  const home = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    ...cliEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    SLICC_CDP_PORTS: '9300-9309',
    SLICC_NO_TELEMETRY: '1',
  };
}

export function startCdp(t, args, { env, page = null } = {}) {
  const node = spawn(CLI, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ?? cliEnv({ SLICC_CDP_PORTS: '9300-9309', SLICC_NO_TELEMETRY: '1' }),
  });
  const events = [];
  const stderr = [];
  node.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  createInterface({ input: node.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.nonce) {
      page?.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {});
      return;
    }
    events.push(message);
  });
  const exited = new Promise((resolve) =>
    node.on('exit', (code, signal) => resolve({ code, signal }))
  );
  const run = { node, events, stderr, exited };
  run.stop = async () => {
    if (node.exitCode === null) node.kill('SIGTERM');
    return exited;
  };
  t.after(() => run.stop());
  return run;
}

export async function waitListening(run, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = run.events.find((event) => event.event === 'listening' && event.url);
    if (found) return found.url;
    if (run.node.exitCode !== null)
      assert.fail(
        `slicc cdp exited ${run.node.exitCode} before listening: ${run.stderr.join('')}\n${JSON.stringify(run.events)}`
      );
    if (Date.now() >= end)
      assert.fail(
        `slicc cdp never listened: ${run.stderr.join('')}\n${JSON.stringify(run.events)}`
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function httpJson(url, { method = 'GET', headers = {} } = {}) {
  const response = await fetch(url, { method, headers });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

export function dial(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  let closed = null;
  const wake = () => {
    for (const look of [...waiters]) look();
  };
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
    wake();
  });
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const done = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() };
      wake();
      resolve(closed);
    });
  });
  const wait = (check, ms = 60000, label = 'wait') =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = waiters.indexOf(look);
        if (at >= 0) waiters.splice(at, 1);
        reject(
          new Error(
            `${label} unanswered after ${ms}ms; closed=${JSON.stringify(closed)}; last=${JSON.stringify(messages.slice(-5))}`
          )
        );
      }, ms);
      const look = () => {
        const found = check({ messages, closed });
        if (!found) return;
        clearTimeout(timer);
        const at = waiters.indexOf(look);
        if (at >= 0) waiters.splice(at, 1);
        resolve(found);
      };
      waiters.push(look);
      look();
    });
  let next = 0;
  const call = async (method, params = {}, sessionId) => {
    next += 1;
    const id = next;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    const answer = await wait(
      ({ messages: inbox, closed: gone }) => {
        if (gone) return { closed: gone };
        return inbox.find((message) => message.id === id);
      },
      60000,
      `${method} id=${id}`
    );
    if (answer.closed)
      throw new Error(`socket closed before ${method}: ${JSON.stringify(answer.closed)}`);
    return answer;
  };
  return { ws, opened, done, wait, call, messages: () => messages, closed: () => closed };
}
