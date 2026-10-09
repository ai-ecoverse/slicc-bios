import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const packages = new URL('../../src/packages/', import.meta.url);
const read = async (path) => readFile(new URL(path, packages), 'utf8');
const KERNEL = '@ai-ecoverse/slicc-kernel';

test('/opt/agent pins the same slicc-kernel as the base set, and pnpm resolves only that one', async () => {
  const base = JSON.parse(await read('package.json')).dependencies[KERNEL];
  const agent = JSON.parse(await read('agent/package.json')).dependencies[KERNEL];
  assert.ok(base);
  assert.equal(agent, base);
  const resolved = [
    ...(await read('agent/pnpm-lock.yaml')).matchAll(
      /^ {2}'@ai-ecoverse\/slicc-kernel@([^']+)':$/gm
    ),
  ].map(([, version]) => version);
  assert.deepEqual([...new Set(resolved)], [base]);
});
