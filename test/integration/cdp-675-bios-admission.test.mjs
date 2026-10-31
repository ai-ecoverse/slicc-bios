import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { protocol } from './guard-ordering-fixture.mjs';

const five = [
  'Debugger.enable',
  'Debugger.disable',
  'Debugger.resume',
  'Debugger.setInstrumentationBreakpoint',
  'Debugger.removeBreakpoint',
];

for (const route of [
  { kind: 'extension', version: '7.10.1' },
  { kind: 'link', version: '1.49.37' },
]) {
  test(`bios admits only the five Stage1 methods behind the ${route.kind} floor`, async (t) => {
    const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route));
    p.target('ordinary');
    const session = await p.attach('ordinary');
    for (const method of five) {
      const start = p.sent.length;
      const answer = await p.send(method, {}, session);
      assert.equal(answer.error, undefined, method);
      assert.equal(p.clients(start).filter((m) => m.method === method).length, 1);
    }
    for (const method of [
      'Debugger.pause',
      'Debugger.getScriptSource',
      'Debugger.evaluateOnCallFrame',
      'Debugger.setBreakpoint',
      'Debugger.setBreakpointByUrl',
      'DOMDebugger.setEventListenerBreakpoint',
      'EventBreakpoints.setInstrumentationBreakpoint',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.addBinding',
    ]) {
      const start = p.sent.length;
      assert.match((await p.send(method, {}, session)).error.message, /slicc: refused:/);
      assert.equal(p.clients(start).length, 0, method);
    }
  });
}

for (const route of [
  undefined,
  { kind: 'extension', version: '7.10.0' },
  { kind: 'link', version: '1.49.36' },
  { kind: 'link', version: 'dev' },
  { kind: 'extension', version: '7.10.1-beta' },
]) {
  test(`bios refuses Stage1 with an unproved route floor ${JSON.stringify(route)}`, async (t) => {
    const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route));
    p.target('ordinary');
    const session = await p.attach('ordinary');
    for (const method of five) {
      const start = p.sent.length;
      assert.match((await p.send(method, {}, session)).error.message, /slicc: refused:/);
      assert.equal(p.clients(start).length, 0);
    }
  });
}
