import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeRegistry, localRelease, REMOTES } from './fake-npm.mjs';

const UPSKILL = '@ai-ecoverse/gh-upskill';
const TOOLS = `/opt/slicc/tools/node_modules/${UPSKILL}`;
const SKILLS = '/usr/share/skills';
const REPO = 'ai-ecoverse/upskill-fixture';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const skill = (version) =>
  `---\nname: demo\ndescription: A skill seven updates with upskill, ${version}.\n---\n\n# Demo ${version}\n`;
const FILES = {
  'skills/demo/SKILL.md': { mode: '100644', text: skill('version two') },
  'skills/demo/scripts/run': { mode: '100755', text: '#!/bin/sh\necho two\n' },
};

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const json = (value) => JSON.stringify(value);

function fakeGitHub() {
  const asked = [];
  const commits = (sha) => json([{ sha, commit: { message: sha === NEW ? 'two' : 'one' } }]);
  const tree = {
    sha: NEW,
    truncated: false,
    tree: [
      { path: 'skills', type: 'tree', mode: '040000', sha: sha1('skills') },
      { path: 'skills/demo', type: 'tree', mode: '040000', sha: sha1('demo') },
      { path: 'skills/demo/scripts', type: 'tree', mode: '040000', sha: sha1('scripts') },
      ...Object.entries(FILES).map(([path, { mode, text }]) => ({
        path,
        type: 'blob',
        mode,
        sha: sha1(text),
        size: text.length,
      })),
    ],
  };
  const serve = async (address) => {
    const url = new URL(address);
    if (url.hostname !== 'api.github.com') return null;
    asked.push(`${url.pathname}${url.search}`);
    const base = `/repos/${REPO}`;
    const path = decodeURIComponent(url.pathname);
    const query = url.searchParams;
    if (path === base) return json({ full_name: REPO, default_branch: 'main' });
    if (path === `${base}/commits` && query.get('path') === 'skills/demo')
      return commits(query.get('sha') === OLD ? OLD : NEW);
    if (path === `${base}/commits/main` || path === `${base}/commits/${NEW}`)
      return json({ sha: NEW });
    if (path === `${base}/git/trees/${NEW}`) return json(tree);
    const file = path.startsWith(`${base}/contents/`) && path.slice(`${base}/contents/`.length);
    if (file && FILES[file] && query.get('ref') === NEW) return FILES[file].text;
    return { status: 404, body: json({ message: 'Not Found' }) };
  };
  return { asked, serve };
}

const github = fakeGitHub();
const chrome = await launch({ timeout: 120000, intercept: [] });
after(() => chrome.close());
const releases = env.SLICC_UPSKILL_TGZ
  ? [
      await localRelease({
        tarball: await readFile(env.SLICC_UPSKILL_TGZ),
        repository: 'https://github.com/ai-ecoverse/gh-upskill',
        workflow: '.github/workflows/ci.yml',
      }),
    ]
  : [];
await fakeRegistry(chrome.cdp, [github, ...releases], [...REMOTES, 'https://api.github.com/']);

async function client(page) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.upskillClient ??= await globalThis.sliccKernelClient();
    globalThis.upskillRuns ??= new Map();
  });
}

async function start(page, command, label, user = null) {
  await client(page);
  await page.evaluate(
    ({ command, label, user }) => {
      globalThis.upskillRuns.set(
        label,
        globalThis.upskillClient
          .run(['bash', '-c', command], user ? { cwd: `/home/${user}`, user } : { cwd: '/' })
          .then(
            ({ status, stdout, stderr }) => ({
              code: String(status),
              out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
            }),
            (error) => ({ code: 'error', out: error.message })
          )
      );
    },
    { command, label, user }
  );
}

const finish = (page, label) => page.evaluate((label) => globalThis.upskillRuns.get(label), label);

async function sh(page, command, label, user = null) {
  await start(page, command, label, user);
  return finish(page, label);
}

async function decide(page, decision) {
  const request = await page.within(
    60000,
    () => document.querySelector('slicc-app').model.approvals?.list()[0]
  );
  await page.evaluate(
    ({ id, decision }) => document.querySelector('slicc-app').model.approvals.decide(id, decision),
    { id: request.id, decision }
  );
  return request;
}

const marker = json({
  kind: 'github',
  source: REPO,
  skill: 'demo',
  path: 'skills/demo',
  sha: OLD,
  version: 1,
  installed: '2026-11-01T00:00:00Z',
  files: ['SKILL.md', 'scripts/old'],
});

test('seven ships upskill root-owned in /usr/bin: a cone runs it and lists the outdated global skills, and sudo upskill updates one in /usr/share/skills, keeping its state', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);

  const row = await page.evaluate(
    (name) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.package === name),
    UPSKILL
  );
  assert.equal(row?.state, 'installed', `the ${UPSKILL} row: ${JSON.stringify(row)}`);

  const where = await sh(
    page,
    `command -v upskill gh-upskill; stat -c '%U %a' /usr/bin/upskill /usr/bin/gh-upskill ${TOOLS}/upskill; test ! -e /usr/local/share/pnpm/bin/upskill && echo no-shim`,
    'where'
  );
  assert.equal(
    where.out,
    `/usr/bin/upskill\n/usr/bin/gh-upskill\nroot 755\nroot 755\nroot 755\nno-shim`,
    where.out
  );

  const version = `upskill ${row.version}`;
  const cone = await sh(page, 'upskill --version; gh-upskill --version', 'cone-version', 'cone');
  assert.deepEqual(cone, { code: '0', out: `${version}\n${version}` });

  const seeded = await sh(
    page,
    `set -e; D=${SKILLS}/demo; mkdir -p "$D/scripts"; printf '%s' '${skill('version one')}' > "$D/SKILL.md"; printf '#!/bin/sh\\necho one\\n' > "$D/scripts/old"; chmod 755 "$D/scripts/old"; printf '%s' '${marker}' > "$D/.upskill"; echo '{"ts":"1"}' > "$D/.last-post-C1.json"; chmod -R a+rX ${SKILLS}; stat -c '%U %a' ${SKILLS} "$D"`,
    'seed'
  );
  assert.deepEqual(seeded, { code: '0', out: 'root 755\nroot 755' });

  const outdated = await sh(page, `upskill outdated --dest ${SKILLS}`, 'outdated', 'cone');
  assert.equal(outdated.code, '0', outdated.out);
  assert.match(outdated.out, /^ {2}demo +aaaaaaa +bbbbbbb +ai-ecoverse\/upskill-fixture /m);
  assert.match(outdated.out, /1 of 1 tracked skill\(s\) can be updated/);

  const unprivileged = await sh(
    page,
    `upskill update demo --dest ${SKILLS}`,
    'update-cone',
    'cone'
  );
  assert.notEqual(unprivileged.code, '0', unprivileged.out);
  assert.match(unprivileged.out, /Permission denied|EACCES/, unprivileged.out);

  await start(page, `sudo upskill update demo --dest ${SKILLS}`, 'update-sudo', 'cone');
  const asked = await decide(page, 'once');
  assert.match(asked.command, /upskill update demo --dest \/usr\/share\/skills/);
  const updated = await finish(page, 'update-sudo');
  assert.equal(updated.code, '0', updated.out);

  const after = await sh(
    page,
    `D=${SKILLS}/demo; sed -n 3p "$D/SKILL.md"; "$D/scripts/run"; test ! -e "$D/scripts/old" && echo old-gone; cat "$D/.last-post-C1.json"; jq -r '.sha, (.files | join(","))' "$D/.upskill"; stat -c '%U' "$D/SKILL.md"; upskill outdated --dest ${SKILLS}`,
    'after',
    'cone'
  );
  assert.equal(after.code, '0', after.out);
  assert.deepEqual(after.out.split('\n'), [
    'description: A skill seven updates with upskill, version two.',
    'two',
    'old-gone',
    '{"ts":"1"}',
    NEW,
    'SKILL.md,scripts/run',
    'root',
    'All 1 tracked skill(s) are up to date.',
  ]);
  assert.ok(
    github.asked.some((at) => at.startsWith(`/repos/${REPO}/git/trees/${NEW}`)),
    github.asked.join('\n')
  );
  assert.deepEqual(page.errors, []);
});
