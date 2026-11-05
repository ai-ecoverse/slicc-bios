import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApprovals, routeSudo } from '../../src/seed/approvals.js';

const request = (fields = {}) => ({
  id: 'sudo-1',
  kind: 'sudo',
  path: '/usr/bin/jq',
  argv: ['jq', '.rules', '/etc/slicc/secrets-policy.toml'],
  user: 'cone',
  uid: 1000,
  tag: '{"kind":"user","where":"terminal:1"}',
  target: 'root',
  cwd: '/',
  createdAt: 0,
  expiresAt: Date.now() + 60000,
  always: true,
  stdin: 'tty',
  rootOnly: { '/': true, '/etc/slicc/secrets-policy.toml': true },
  ...fields,
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

function tabs() {
  const ends = [
    { postMessage: (data) => setImmediate(() => ends[1].onmessage?.({ data })), onmessage: null },
    { postMessage: (data) => setImmediate(() => ends[0].onmessage?.({ data })), onmessage: null },
  ];
  return ends;
}

const lone = () => ({ postMessage() {}, onmessage: null });

async function listed(approvals) {
  for (let i = 0; i < 100 && !approvals.port.list().length; i += 1) await turn();
  return approvals.port.list();
}

const eagain = () => Object.assign(new Error('the agent is restarting'), { code: 'EAGAIN' });

test('with the agent up, routeSudo hands the kernel’s request to the agent unchanged, always, stdin and rootOnly included, and returns its answer', async () => {
  const seen = [];
  const fallback = () => assert.fail('the fallback dialog asked while the agent was up');
  const sudo = routeSudo({
    judges: () => true,
    agent: () => ({
      approve: async (req, options) => {
        seen.push({ req, options });
        return 'always';
      },
    }),
    fallback,
    where: () => 'on phone',
  });
  const req = request();
  const signal = new AbortController().signal;
  assert.equal(await sudo(req, { signal }), 'always');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].req, req);
  assert.deepEqual(seen[0].req, request({ expiresAt: req.expiresAt }));
  assert.deepEqual(seen[0].options, { signal, where: 'on phone' });
});

test('a command line the kernel can’t record arrives at the agent with always: false, and the agent’s always answer goes back to the kernel, which runs it once', async () => {
  const seen = [];
  const sudo = routeSudo({
    judges: () => true,
    agent: () => ({
      approve: async (req) => {
        seen.push(req);
        return 'always';
      },
    }),
    fallback: () => assert.fail('the fallback dialog asked while the agent was up'),
  });
  const req = request({ argv: ['printf', '%s', 'a\rb'], path: '/usr/bin/printf', always: false });
  assert.equal(await sudo(req, {}), 'always');
  assert.equal(seen[0].always, false);
  assert.deepEqual(seen[0].argv, ['printf', '%s', 'a\rb']);
  assert.equal(seen[0].stdin, 'tty');
});

test('bios checks no command text: whatever the agent answers for any line is what the kernel gets', async () => {
  const lines = [
    ['/usr/bin/xargs', ['xargs', 'sort']],
    ['/bin/bash', ['bash', '-c', 'echo $HOME > /etc/fnox/config.toml']],
    ['/usr/bin/tee', ['tee', '/etc/slicc/secrets-policy.toml']],
    ['/usr/bin/ls', ['ls', '-la', '/tmp/*']],
  ];
  for (const [path, argv] of lines) {
    for (const answer of ['once', 'always', 'deny']) {
      const sudo = routeSudo({
        judges: () => true,
        agent: () => ({ approve: async () => answer }),
        fallback: () => assert.fail('the fallback dialog asked while the agent was up'),
      });
      assert.equal(await sudo(request({ path, argv, stdin: 'pipe' }), {}), answer, argv.join(' '));
    }
  }
});

test('with the agent down, the fallback dialog offers Allow once and Deny only, with no verdict', async () => {
  for (const agent of [
    () => undefined,
    () => ({}),
    () => ({ approve: async () => Promise.reject(eagain()) }),
  ]) {
    const approvals = createApprovals({ channel: lone() });
    approvals.own();
    const sudo = routeSudo({ agent, judges: () => true, fallback: approvals.approve });
    const decision = sudo(request(), {});
    const [item] = await listed(approvals);
    assert.deepEqual(item, {
      id: 'sudo-1',
      kind: 'sudo',
      requester: { kind: 'user', name: 'cone', where: 'a terminal' },
      command: '/usr/bin/jq .rules /etc/slicc/secrets-policy.toml',
      target: 'root',
      cwd: '/',
      createdAt: 0,
      expiresAt: item.expiresAt,
      always: false,
    });
    assert.equal('verdict' in item, false);
    await approvals.port.decide(item.id, 'once');
    assert.equal(await decision, 'once');
  }
});

test('an agent that runs without the judge gets nothing: the fallback dialog asks with once and deny only', async () => {
  for (const judges of [() => false, undefined]) {
    const approvals = createApprovals({ channel: lone() });
    approvals.own();
    const sudo = routeSudo({
      agent: () => ({ approve: async () => assert.fail('an agent without the judge was asked') }),
      ...(judges ? { judges } : {}),
      fallback: approvals.approve,
    });
    const decision = sudo(request(), {});
    const [item] = await listed(approvals);
    assert.equal(item.always, false);
    await assert.rejects(approvals.port.decide(item.id, 'always'), /Always isn't offered/);
    await approvals.port.decide(item.id, 'once');
    assert.equal(await decision, 'once');
  }
});

test('the fallback dialog refuses an always decision as the agent does, and the request stays open for once or deny', async () => {
  const approvals = createApprovals({ channel: lone() });
  approvals.own();
  const sudo = routeSudo({ agent: () => undefined, fallback: approvals.approve });
  let settled = null;
  const decision = sudo(request(), {}).then((answer) => {
    settled = answer;
    return answer;
  });
  const [item] = await listed(approvals);
  await assert.rejects(approvals.port.decide(item.id, 'always'), /Always isn't offered/);
  await turn();
  assert.equal(settled, null);
  assert.deepEqual(
    approvals.port.list().map(({ id }) => id),
    [item.id]
  );
  await approvals.port.decide(item.id, 'deny');
  assert.equal(await decision, 'deny');
});

test('an always decision from another tab for a fallback item is ignored, and that tab’s once answers it', async () => {
  const [mine, theirs] = tabs();
  const owner = createApprovals({ channel: mine });
  const other = createApprovals({ channel: theirs });
  owner.own();
  const decision = owner.approve(request());
  const [item] = await listed(other);
  assert.equal(item.always, false);
  await assert.rejects(other.port.decide(item.id, 'always'), /Always isn't offered/);
  theirs.postMessage({ decide: { id: item.id, decision: 'always' } });
  for (let i = 0; i < 20; i += 1) await turn();
  assert.deepEqual(
    owner.port.list().map(({ id }) => id),
    [item.id]
  );
  await other.port.decide(item.id, 'once');
  assert.equal(await decision, 'once');
});

test('an agent that fails any other way denies the request', async () => {
  const sudo = routeSudo({
    judges: () => true,
    agent: () => ({ approve: async () => Promise.reject(new Error('boom')) }),
    fallback: () => assert.fail('the fallback dialog asked for a failure that isn’t EAGAIN'),
  });
  assert.equal(await sudo(request(), {}), 'deny');
});
