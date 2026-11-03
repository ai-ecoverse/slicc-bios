import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export function ownerPushFixture(options = {}) {
  const file = options.source ?? new URL('./cdp-675-packaged.test.mjs', import.meta.url);
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('async function privateDomReadRow(');
  const end = source.indexOf('async function lifecycleRow(', start);
  assert.ok(start >= 0 && end > start);
  const root = {
    nodeId: 17,
    backendNodeId: 2,
    children: [
      {
        nodeId: 18,
        backendNodeId: 5,
        shadowRoots: [{ backendNodeId: 6 }],
        contentDocument: { backendNodeId: 7 },
      },
    ],
  };
  if (options.boundOwner) root.children.push({ nodeId: 19, backendNodeId: 10 });
  const calls = [];
  let waited = false;
  let closed = false;
  const context = vm.createContext({
    assert,
    cdp675Trace: [
      {
        boundary: 'bios',
        direction: 'receive',
        packet: { method: 'DOM.setChildNodes', sessionId: 'client' },
      },
    ],
    cdp675Lifecycle: {
      close() {
        closed = true;
      },
    },
    sliccExtension: {
      async frames(target) {
        assert.equal(target, 11);
        return { version: 1, remoteOwners: [{ frameId: 'remote', backendNodeId: 10 }] };
      },
    },
    async lifecycleOpen() {
      return { result: { sessionId: 'client' } };
    },
    async lifecycleCall(_page, method, params) {
      calls.push({ method, params });
      if (method === 'DOM.getDocument') {
        assert.equal(params.depth, 1);
        assert.equal(params.pierce, false);
        return { result: { root } };
      }
      if (method === 'DOM.querySelectorAll') {
        assert.equal(params.nodeId, 17);
        return { result: { nodeIds: [] } };
      }
      return { result: {} };
    },
  });
  const code =
    '\n'.repeat(source.slice(0, start).split('\n').length - 1) +
    source.slice(start, end) +
    '\n;privateDomReadRow';
  const run = vm.runInContext(code, context, { filename: fileURLToPath(file) });
  const page = {
    async evaluate(fn, args) {
      return fn(args);
    },
    async within(bound, predicate, args) {
      waited = true;
      assert.equal(bound, 2000);
      assert.equal(await predicate(args), false);
      const event = {
        method: 'DOM.setChildNodes',
        sessionId: 'client',
        params: {
          parentId: 18,
          nodes: [
            {
              backendNodeId: 9,
              documentURL: options.protectedPush
                ? 'https://vault.sliccy.ai/protected-push'
                : 'https://ordinary.test/',
            },
          ],
        },
      };
      context.cdp675Trace.push({
        boundary: 'bios',
        direction: 'receive',
        packet: { ...event, sessionId: 'unrelated' },
      });
      assert.equal(await predicate(args), false);
      if (options.missingPush) throw new Error('client push wait expired');
      context.cdp675Trace.push({ boundary: 'route', direction: 'receive', packet: event });
      context.cdp675Trace.push({ boundary: 'bios', direction: 'receive', packet: event });
      assert.equal(await predicate(args), true);
    },
  };
  const row = { target: '11', traceStart: 0 };
  return {
    row,
    calls,
    run: (scene = { privateOwnerPush: true }) => run(page, row, scene),
    get waited() {
      return waited;
    },
    get closed() {
      return closed;
    },
  };
}
