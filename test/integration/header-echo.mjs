import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const DUMMY_COOKIE = 'session=dummy-not-a-credential';
export const ORDINARY = { 'X-Probe': 'visible' };

export async function startEcho() {
  const asked = [];
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    asked.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://host.slicc.internal:${server.address().port}`,
    reached: (path) => asked.filter((entry) => entry.url === path),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const PROGRAM = `export default async function main(ctx) {
  const [url, given] = ctx.argv.slice(1);
  const line = await ctx.fetch(url, { headers: JSON.parse(given) }).then(
    async (r) => JSON.stringify({ status: r.status, body: await r.text() }),
    (err) => JSON.stringify({
      name: err.name,
      message: err.message,
      cause: { code: err.cause?.code, detail: err.cause?.detail ?? null, message: err.cause?.message },
    })
  );
  await ctx.write(1, line + '\\n');
}
`;
const PACKAGE = {
  name: 'headerfetch',
  version: '0.0.0',
  slicc: { commands: { headerfetch: { abi: 'js', module: 'main.mjs' } } },
};

export async function headerFetch(page) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(
    async ([pkg, program]) => {
      globalThis.headerClient = await globalThis.sliccKernelClient();
      const dir = '/opt/user/node_modules/headerfetch';
      await globalThis.headerClient.fs.mkdir(dir);
      await globalThis.headerClient.fs.writeFile(`${dir}/package.json`, pkg);
      await globalThis.headerClient.fs.writeFile(`${dir}/main.mjs`, program);
    },
    [JSON.stringify(PACKAGE), PROGRAM]
  );
  await page.within(
    30000,
    async () => (await globalThis.headerClient.run(['headerfetch'], { cwd: '/' })).status !== 127
  );
  const sh = (line) =>
    page.evaluate((line) => globalThis.headerClient.run(['bash', '-c', line], { cwd: '/' }), line);
  const fetchWith = async (url, headers) => {
    const { status, stdout, stderr } = await page.evaluate(
      (argv) => globalThis.headerClient.run(argv, { cwd: '/' }),
      ['headerfetch', url, JSON.stringify(headers)]
    );
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout.trim());
  };
  return { sh, fetchWith };
}

export const curlArgs = (headers) =>
  Object.entries(headers)
    .map(([name, value]) => `-H '${name}: ${value}'`)
    .join(' ');

export function echoed(answer) {
  assert.equal(answer.status, 200, JSON.stringify(answer));
  return JSON.parse(answer.body);
}
