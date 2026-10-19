import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, agentState, agentUp, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeNtfy } from './fake-ntfy.mjs';

const HOST = 'ntfy.example.test';
const ntfy = await fakeNtfy({ host: HOST });
const chrome = await launch({
  agent: true,
  args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
});
const url = `http://${HOST}:${ntfy.port}`;
after(async () => {
  await ntfy.close();
  await chrome.close();
});

const HANDLER = `agent send cone --lick=webhook --source github "$NTFY_RAW"`;

const chat = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active()));
  });

const count = (text, needle) => text.split(needle).length - 1;

async function inChat(page, needle, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await chat(page);
    if (text.includes(needle)) return text;
    if (Date.now() > deadline)
      throw new Error(
        `${needle} never reached the cone within ${ms / 1000} s\n${text.slice(-2000)}\nscreen:\n${await screen(page)}\n${await agentState(page)}`
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

test('ntfy sub with agent send --lick=webhook as its command turns a published message into one webhook lick in the cone, and a replay with --since all delivers it once', {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await agentUp(page);
  assert.equal(await actPackage(page, 'ntfy', 'install'), 'ok');
  await run(
    page,
    `clear; mkdir -p /home/cone/.slicc/webhooks && printf '%s\\n' '{ "target": "cone", "message": "A GitHub event arrived through ntfy." }' > /home/cone/.slicc/webhooks/github.json && chown -R cone:cone /home/cone/.slicc && ok=1; for i in $(seq 1 60); do if sudo -u cone agent send cone --lick=webhook --source github 'webhook config probe' > /dev/null 2>&1; then ok=0; break; fi; sleep 1; done; echo "configured $((40 + ok))"`
  );
  await shows(page, 'configured 4', 120000);
  assert.match(await screen(page), /configured 40/);

  const first = ntfy.publish('hooks', {
    message: 'push to main: ntfy-lick-alpha',
    title: 'push',
    headers: { 'x-github-event': 'push' },
  });
  await run(
    page,
    `clear; sudo -u cone ntfy sub --poll --since all ${url}/hooks '${HANDLER}'; echo "delivered $((40 + $?))"`
  );
  await shows(page, 'delivered 4', 120000);
  const once = await inChat(page, 'ntfy-lick-alpha', 120000);
  assert.match(once, /webhook/);
  const seen = count(once, 'ntfy-lick-alpha');

  ntfy.publish('hooks', { message: 'push to main: ntfy-lick-beta', title: 'push' });
  await run(
    page,
    `clear; sudo -u cone ntfy sub --poll --since all ${url}/hooks '${HANDLER}'; echo "replayed $((40 + $?))"`
  );
  await shows(page, 'replayed 4', 120000);
  const replayed = await inChat(page, 'ntfy-lick-beta', 120000);
  assert.equal(count(replayed, 'ntfy-lick-alpha'), seen, `${first.id} was delivered twice`);
  assert.deepEqual(page.errors, []);
});
