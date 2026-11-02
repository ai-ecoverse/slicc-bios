import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { boundedHooks, boundedStage, rowDeadline } from './cdp-675-deadline.mjs';

test('whole-row deadline rejects a hung command and prevents further commands without changing sync observers', async () => {
  const row = { name: 'owned', step: 'native tap', status: 'pass' };
  const deadline = rowDeadline(row, 20);
  let sends = 0;
  const object = {
    tag: 12,
    on() {
      return this.tag;
    },
    async send() {
      sends += 1;
      return new Promise(() => {});
    },
  };
  const wrapped = deadline.wrap(object, ['send']);
  assert.equal(wrapped.on(), 12);
  assert.equal(wrapped.tag, 12);
  await assert.rejects(wrapped.send(), /whole row owned exceeded 20ms at native tap/);
  await assert.rejects(wrapped.send(), /whole row/);
  assert.equal(sends, 1);
  deadline.end();
  assert.equal(row.status, 'finding');
  assert.equal(row.failure.name, 'RowTimeout');
  assert.ok(row.deadline.expiredAt >= row.deadline.started + 15);
});

test('successful deadline preserves results, this binding, real errors and cancels its timer', async () => {
  const row = { name: 'ordinary', status: 'pass' };
  const deadline = rowDeadline(row, 1000);
  const answer = { unchanged: true };
  const error = new Error('real refusal');
  const wrapped = deadline.wrap(
    {
      answer,
      async send(method) {
        if (method === 'refused') throw error;
        return this.answer;
      },
    },
    ['send']
  );
  assert.equal(await wrapped.send('ordinary'), answer);
  await assert.rejects(wrapped.send('refused'), (thrown) => thrown === error);
  assert.equal(deadline.wrap(null, ['send']), null);
  deadline.end();
  assert.equal(row.status, 'pass');
  assert.equal(row.deadline.expiredAt, undefined);
});

test('bounded teardown records the precise stalled stage and permits the next hook to report', async () => {
  const trace = { route: 'extension', mode: 'ordinary' };
  const callbacks = [];
  let persisted = 0;
  const context = {
    name: 'real test context',
    after(callback) {
      callbacks.push(callback);
    },
  };
  const bounded = boundedHooks(
    context,
    trace,
    async () => {
      persisted += 1;
    },
    15
  );
  assert.equal(bounded.name, context.name);
  bounded.after(async () => new Promise(() => {}));
  bounded.after(async () => 'completed');
  await assert.rejects(callbacks[0](), /after-1/);
  await callbacks[1]();
  assert.equal(persisted, 2);
  assert.equal(trace.stages[0].status, 'finding');
  assert.equal(trace.stages[1].status, 'pass');
  const answer = { unchanged: true };
  assert.equal(await boundedStage(trace, 'browser-close', async () => answer, 100), answer);
});

test('candidate row paths, raw tap, driver waits and final teardown are all inside finite budgets', async () => {
  const source = await readFile(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
  assert.match(source, /const deadline = rowDeadline\(row\)/);
  assert.match(source, /deadline.wrap\(suitePage, \['evaluate', 'send', 'goto', 'init'\]\)/);
  assert.match(source, /deadline.wrap\(suiteChrome.cdp, \['send'\]\)/);
  assert.match(source, /deadline.wait\(\(\) => bfcacheDriver.prepare\(\)\)/);
  assert.match(source, /deadline.wait\(\(\) => bfcacheDriver.close\(\)\)/);
  assert.match(source, /deadline.end\(\);[\s\S]*countRow\(row\);/);
  assert.match(source, /boundedStage\(trace,.*browser-close/);
  assert.match(source, /boundedHooks\(context, trace, persist\)/);
  const workflow = await readFile(
    new URL('../../.github/workflows/cdp-675-stage1.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /timeout -k 30 2700 node --test --test-force-exit/);
  assert.match(workflow, /runner.temp.*candidate.log/);
});
