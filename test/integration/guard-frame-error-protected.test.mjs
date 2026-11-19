import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { plainFrame, protocol } from './guard-ordering-fixture.mjs';

const route = { kind: 'extension', version: '7.15.0' };
const dom = (ids) => ({
  nodeId: 1,
  nodeName: '#document',
  children: ids.map((frameId, index) => ({
    nodeName: 'IFRAME',
    frameId,
    backendNodeId: index + 2,
    attributes: ['src', 'https://ordinary-cross.test/'],
  })),
});
const placeable = (entries) => ({
  version: 2,
  rootFrameId: 'root',
  rootLoaderId: 'root-loader',
  revision: 0,
  localFrames: ['root'],
  remoteOwners: entries.map((_, index) => ({
    frameId: `remote-${index}`,
    backendNodeId: index + 2,
  })),
  frames: [
    { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
    ...entries.map((entry, index) => ({ frameId: index + 1, parentFrameId: 0, ...entry })),
  ],
});

function fixture(t, list) {
  let reads = 0;
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), route, async () => {
      reads++;
      return structuredClone(list);
    })
  );
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'root-loader' });
  root.dom = dom(list.frames.slice(1).map((_, index) => `remote-${index}`));
  return { p, reads: () => reads };
}

async function drive(t, list) {
  const { p, reads } = fixture(t, list);
  const session = await p.attach('root');
  const debug = await p.send('Debugger.enable', {}, session);
  const read = await p.send('DOM.getDocument', { depth: 1 }, session);
  const shot = await p.send('Page.captureScreenshot', {}, session);
  assert.ok(reads() > 0, 'the private frame list was read');
  return { p, debug, read, shot };
}

const refused = (answer, what) =>
  assert.match(
    answer.error?.message ?? '',
    /^slicc: refused:/,
    `${what}: ${JSON.stringify(answer)}`
  );

test('an error iframe the extension marks errorProtected: false is an ordinary frame, and its page is placed and drivable', async (t) => {
  const { p, debug, read, shot } = await drive(
    t,
    placeable([{ kind: 'error', errorProtected: false }])
  );
  assert.equal(debug.error, undefined, JSON.stringify(debug));
  assert.equal(read.error, undefined, JSON.stringify(read));
  assert.equal(read.result.root.nodeName, '#document');
  assert.equal(shot.error, undefined, JSON.stringify(shot));
  assert.equal(p.clients().filter(({ method }) => method === 'Debugger.enable').length, 1);
});

test('an ordinary sibling and an error iframe marked errorProtected: false together place the page', async (t) => {
  const { debug, read } = await drive(
    t,
    placeable([{ kind: 'ordinary' }, { kind: 'error', errorProtected: false }])
  );
  assert.equal(debug.error, undefined, JSON.stringify(debug));
  assert.equal(read.error, undefined, JSON.stringify(read));
});

for (const [name, entry] of [
  ['errorProtected: true', { kind: 'error', errorProtected: true }],
  ['no errorProtected', { kind: 'error' }],
  ['errorProtected: "false"', { kind: 'error', errorProtected: 'false' }],
  ['errorProtected: 0', { kind: 'error', errorProtected: 0 }],
  ['errorProtected: null', { kind: 'error', errorProtected: null }],
  ['errorProtected: {}', { kind: 'error', errorProtected: {} }],
  ['errorProtected: false on an unknown kind', { kind: 'unknown', errorProtected: false }],
]) {
  test(`an error iframe with ${name} keeps its page locked for debugger, DOM and paint`, async (t) => {
    const { p, debug, read, shot } = await drive(t, placeable([entry]));
    refused(debug, 'Debugger.enable');
    refused(read, 'DOM.getDocument');
    refused(shot, 'Page.captureScreenshot');
    assert.doesNotMatch(JSON.stringify(p.delivered), /ordinary-cross\.test/);
    assert.equal(
      p.clients().some(({ method }) => ['Debugger.enable', 'DOM.getDocument'].includes(method)),
      false
    );
  });
}

test('a protected error iframe next to an ordinary error iframe and an ordinary frame keeps the page locked', async (t) => {
  const { debug, read, shot } = await drive(
    t,
    placeable([
      { kind: 'ordinary' },
      { kind: 'error', errorProtected: false },
      { kind: 'error', errorProtected: true },
    ])
  );
  refused(debug, 'Debugger.enable');
  refused(read, 'DOM.getDocument');
  refused(shot, 'Page.captureScreenshot');
});

test('a protected frame next to an ordinary error iframe revokes the page', async (t) => {
  const { debug, read } = await drive(
    t,
    placeable([{ kind: 'error', errorProtected: false }, { kind: 'protected' }])
  );
  refused(debug, 'Debugger.enable');
  refused(read, 'DOM.getDocument');
});
