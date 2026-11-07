import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { LINK_ZONES as LINK } from '../../src/seed/tools.js';
import { actPackage, boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeRegistry, localRelease } from './fake-npm.mjs';

const TZDATA = '@ai-ecoverse/tzdata';
const DATA = `/opt/slicc/tools/node_modules/${TZDATA}/share/zoneinfo`;
const BERLIN = 'Europe/Berlin';
const TOKYO = 'Asia/Tokyo';

const chrome = await launch({ timeout: 120000, intercept: [] });
after(() => chrome.close());
const releases = env.SLICC_TZDATA_TGZ
  ? [
      await localRelease({
        tarball: await readFile(env.SLICC_TZDATA_TGZ),
        repository: 'https://github.com/ai-ecoverse/homescoop',
        workflow: '.github/workflows/ladder-build.yml',
      }),
    ]
  : [];
await fakeRegistry(chrome.cdp, releases);

async function sh(page, argv) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(async (argv) => {
    globalThis.zoneClient = await globalThis.sliccKernelClient();
    const { status, stdout, stderr } = await globalThis.zoneClient.run(argv, { cwd: '/' });
    return { code: status, out: `${stdout ?? ''}`.trim(), err: `${stderr ?? ''}`.trim() };
  }, argv);
}

const bash = (page, command) => sh(page, ['bash', '-c', command]);

async function zone(page, id) {
  await page.send('Emulation.setTimezoneOverride', { timezoneId: id });
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
}

const linked = (page) =>
  bash(
    page,
    `printf '%s|' "$TZ" "$(readlink /usr/share/zoneinfo)" "$(head -c 4 /usr/share/zoneinfo/${BERLIN})" "$(readlink /etc/localtime)" "$(head -c 4 /etc/localtime)"`
  );

test('every root, an existing one too, links /usr/share/zoneinfo to the tzdata tool and /etc/localtime to the browser’s zone, and follows the zone across boots', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  chrome.overrides.set('/packages/tools.json', '{}\n');
  await zone(page, BERLIN);
  const before = await bash(
    page,
    'printf %s "$(readlink /usr/share/zoneinfo)" "|" "$(readlink /etc/localtime)"'
  );
  assert.equal(before.out, `${DATA}|/usr/share/zoneinfo/UTC`, 'no data yet: UTC');
  chrome.overrides.delete('/packages/tools.json');
  await zone(page, BERLIN);
  const berlin = await linked(page);
  assert.equal(berlin.code, 0, berlin.err);
  assert.equal(
    berlin.out,
    `${BERLIN}|${DATA}|TZif|/usr/share/zoneinfo/${BERLIN}|TZif|`,
    'TZ, the data link, a TZif zone file and /etc/localtime'
  );

  await zone(page, TOKYO);
  const tokyo = await bash(page, 'printf %s "$TZ" "|" "$(readlink /etc/localtime)"');
  assert.equal(tokyo.out, `${TOKYO}|/usr/share/zoneinfo/${TOKYO}`, 'a new zone moves the link');

  await t.test('WASIX programs read the zone through musl', async () => {
    assert.equal(await actPackage(page, 'python', 'install'), 'ok');
    assert.equal(await actPackage(page, 'perl', 'install'), 'ok');
    const python = await bash(
      page,
      `TZ=${BERLIN} python3 -c 'import time; print(time.strftime("%Z"))'; env -u TZ python3 -c 'import time; print(time.strftime("%Z"))'`
    );
    assert.equal(python.code, 0, python.err);
    assert.match(python.out, /^CES?T\nJST$/, 'python: TZ by name, then /etc/localtime');
    const perl = await bash(
      page,
      `TZ=${BERLIN} perl -MPOSIX -e 'print strftime("%Z", localtime), "\\n"'; env -u TZ perl -MPOSIX -e 'print strftime("%Z", localtime), "\\n"'`
    );
    assert.equal(perl.code, 0, perl.err);
    assert.match(perl.out, /^CES?T\nJST$/, 'perl: TZ by name, then /etc/localtime');
  });

  await t.test(
    'the links leave what someone else made alone, and repair a dangling one',
    async () => {
      const at = '/tmp/zones';
      const run = async (tz, setup = 'true') => {
        const before = await bash(page, setup);
        assert.equal(before.code, 0, before.err);
        const ran = await sh(page, [
          'env',
          `TZ=${tz}`,
          'bash',
          '-c',
          LINK,
          'zoneinfo',
          DATA,
          `${at}/zoneinfo`,
          `${at}/localtime`,
        ]);
        assert.equal(ran.code, 0, ran.err);
        return (
          await bash(
            page,
            `printf '%s|' "$(readlink ${at}/zoneinfo)" "$(readlink ${at}/localtime)" "$(head -c 4 ${at}/localtime)"`
          )
        ).out;
      };
      const ours = `${DATA}|${at}/zoneinfo/${BERLIN}|TZif|`;
      assert.equal(await run(BERLIN, `rm -rf ${at}; mkdir -p ${at}`), ours, 'a fresh root');
      assert.equal(await run(BERLIN), ours, 'idempotent');
      assert.equal(
        await run('Nowhere/Atlantis'),
        `${DATA}|${at}/zoneinfo/UTC|TZif|`,
        'a zone without a file falls back to UTC'
      );
      assert.equal(
        await run(BERLIN, `ln -sfn /nowhere ${at}/zoneinfo`),
        ours,
        'a dangling data link'
      );
      assert.equal(
        await run(BERLIN, `ln -sfn /nowhere ${at}/localtime`),
        ours,
        'a dangling localtime'
      );
      const real = `rm -f ${at}/zoneinfo ${at}/localtime; mkdir -p ${at}/zoneinfo/Europe && cp ${DATA}/${TOKYO} ${at}/zoneinfo/${BERLIN}`;
      assert.equal(
        await run(BERLIN, real),
        `|${at}/zoneinfo/${BERLIN}|TZif|`,
        'a real directory stays'
      );
      assert.equal(
        await run(BERLIN, `rm -f ${at}/localtime; echo mine > ${at}/localtime`),
        '||mine|',
        'a regular localtime stays'
      );
      assert.equal(
        await run(BERLIN, `rm -f ${at}/localtime; ln -s ${DATA}/UTC ${at}/localtime`),
        `|${DATA}/UTC|TZif|`,
        'a working link elsewhere stays'
      );
    }
  );
  assert.deepEqual(page.errors, []);
});
