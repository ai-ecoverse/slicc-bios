import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { env } from 'node:process';
import { test } from 'node:test';
import { prompt, ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const listed = env.CERT_COMMANDS;
const timeout = Number(env.CERT_TIMEOUT ?? 180000);
const kept = 20000;

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return await (await dir.getFileHandle(name)).getFile().then((file) => file.text());
    } catch {
      return null;
    }
  }, path);
}

export function commands(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function wrapped(command, n) {
  const out = `/home/.cert/${n}.out`;
  const rc = `/home/.cert/${n}.rc`;
  return `mkdir -p /home/.cert; { ${command}\n} > ${out} 2>&1; echo "$?" > ${rc}; echo "cert-$((${n} * 7 + 1))-done"`;
}

test('runs the cert commands in seven and records each exit status and output', {
  skip: !listed,
  timeout: Infinity,
}, async (t) => {
  const chrome = await launch({ agent: env.CERT_AGENT === '1' });
  t.after(() => chrome.close());
  const page = await chrome.page(t);
  await page.goto(env.CERT_PATH ?? '/');
  await ready(page, [env.CERT_PROMPT ?? prompt]);
  const results = [];
  for (const [n, command] of commands(await readFile(listed, 'utf8')).entries()) {
    const started = Date.now();
    await run(page, wrapped(command, n));
    let status = 'done';
    try {
      await shows(page, `cert-${n * 7 + 1}-done`, timeout);
    } catch {
      status = 'timeout';
    }
    const rc = (await read(page, `home/.cert/${n}.rc`))?.trim() ?? null;
    const output = (await read(page, `home/.cert/${n}.out`)) ?? '';
    results.push({
      command,
      status,
      rc: rc === null ? null : Number(rc),
      ms: Date.now() - started,
      output:
        output.length > kept
          ? `${output.slice(0, kept)}\n[${output.length - kept} more bytes]`
          : output,
    });
    if (status === 'timeout') break;
  }
  await page.screenshot(new URL('seven.png', page.dir));
  const dir = new URL('../../artifacts/cert/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(
    new URL('seven.json', dir),
    `${JSON.stringify({ path: env.CERT_PATH ?? '/', results, errors: page.errors }, null, 2)}\n`
  );
});
