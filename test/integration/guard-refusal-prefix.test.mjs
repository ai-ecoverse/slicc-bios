import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEBUGGER_ROUTE_UPDATE } from '../../src/seed/debugger.js';
import { EXTENSION_UPDATE } from '../../src/seed/extension.js';
import * as guard from '../../src/seed/guard.js';
import { flush, protocol } from './guard-state-fixture.mjs';

const PREFIX = 'slicc: refused: ';
const REFUSALS = {
  PROTECTED: guard.PROTECTED,
  UNSEEN: guard.UNSEEN,
  FETCH: guard.FETCH,
  STREAM: guard.STREAM,
  FAILED: guard.FAILED,
  SCRIPTS: guard.SCRIPTS,
  INHERITED: guard.INHERITED,
  INTERCEPTION: guard.INTERCEPTION,
  UNFLAT: guard.UNFLAT,
  UNGUARDED: guard.UNGUARDED,
  HEADERS: guard.HEADERS,
  WORLD: guard.WORLD,
  UNSEEN_CONTEXT: guard.UNSEEN_CONTEXT,
  PROFILED: guard.PROFILED,
  DEBUGGER: guard.DEBUGGER,
  EXTENSION_FRAME: guard.EXTENSION_FRAME,
  SHOWN_REFUSAL: guard.SHOWN_REFUSAL,
  PRESENT_REFUSAL: guard.PRESENT_REFUSAL,
  CREDENTIAL: guard.CREDENTIAL,
  NO_WORKERS: guard.NO_WORKERS,
  TAB_FOREIGN: guard.TAB_FOREIGN,
  TAB_ONLY: guard.TAB_ONLY,
  STREAMING: guard.STREAMING,
  NO_AUTO_ATTACH: guard.NO_AUTO_ATTACH,
  DEBUGGER_ROUTE_UPDATE,
  EXTENSION_UPDATE,
};
const source = readFileSync(new URL('../../src/seed/guard.js', import.meta.url), 'utf8');

test('every refusal the guard answers with starts with "slicc: refused: "', () => {
  for (const [name, text] of Object.entries(REFUSALS)) {
    assert.equal(typeof text, 'string', `${name} is a string`);
    assert.ok(text.startsWith(PREFIX), `${name} starts with the prefix: ${text}`);
  }
});

test('the list above names every refusal constant guard.js declares or answers with', () => {
  const declared = [...source.matchAll(/^export const ([A-Z_]+) =\s*\n?\s*['"`]slicc: refused/gm)];
  for (const [, name] of declared) assert.ok(name in REFUSALS, `${name} is listed`);
  for (const [literal] of source.matchAll(/['"`][^'"`\n]*refused:[^'"`\n]*['"`]/g))
    assert.ok(
      literal.slice(1).startsWith(PREFIX),
      `a refusal text starts with the prefix: ${literal}`
    );
  const named = new Set([
    ...[...source.matchAll(/this\.refuse\([^,()]+, ([A-Z_]+)\)/g)].map(([, name]) => name),
    ...[...source.matchAll(/code: -32000, message: ([A-Z_]+) /g)].map(([, name]) => name),
    ...[...source.matchAll(/^\s+return ([A-Z_]{4,});$/gm)].map(([, name]) => name),
  ]);
  for (const name of named) assert.ok(name in REFUSALS, `${name}, a guard answer, is listed`);
});

test('the guard forwards the browser’s -32001 missing-session answer as it is, without the prefix', async (t) => {
  const wire = protocol(t);
  const missing = { code: -32001, message: 'Session with given id not found.' };
  wire.hold((message) => message.method === 'Browser.getVersion' && message.id < 2 ** 30);
  const { answer } = wire.request('Browser.getVersion');
  for (let n = 0; n < 100 && !wire.held.length; n++) await flush();
  wire.release(wire.held[0], { error: missing });
  const got = await answer;
  assert.equal(got.error.code, missing.code);
  assert.equal(got.error.message, missing.message);
  assert.ok(!got.error.message.startsWith(PREFIX));
});

test('a sessionless evaluate, a browser-wide Fetch.enable and an unflattened attach are refused with the prefix', async (t) => {
  const wire = protocol(t);
  for (const [method, params, expected] of [
    ['Runtime.evaluate', { expression: '1' }, guard.PROTECTED],
    ['Fetch.enable', {}, guard.FETCH],
    ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false }, guard.UNFLAT],
  ]) {
    const got = await wire.send(method, params);
    assert.equal(got.error?.message, expected, `${method}: ${JSON.stringify(got)}`);
    assert.ok(got.error.message.startsWith(PREFIX));
  }
});
