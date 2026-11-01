import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tapNativeSource(source) {
  assert.equal(source.split('class Connection {').length, 2);
  return `${source}
const cdp675NativeRecord = (record) => {
  const records = globalThis.cdp675NativeTrace ??= [];
  records.push({ at: Date.now(), ...record });
  if (records.length > 20000) records.shift();
};
for (const name of ['sessionCommand', 'admit', 'seal', 'bind', 'send']) {
  const original = Connection.prototype[name];
  Connection.prototype[name] = async function (...args) {
    const command = name === 'sessionCommand';
    const tabId = command ? this.state.sessions.get(args[0].sessionId)?.tabId : args[0];
    const method = command ? args[0].method : name === 'send' ? args[1] : args[2];
    const params = command ? args[1] : name === 'send' ? args[2] : args[3];
    const probe = method === 'Runtime.evaluate' && params?.expression === 'location.href';
    const read = name === 'send' && ['Page.getFrameTree', 'DOMSnapshot.captureSnapshot'].includes(method);
    if (!probe && !read) return original.apply(this, args);
    const state = () => {
      const tab = name === 'send' || command ? this.state.tabs.get(tabId) : args[1];
      return { visible: [...(tab?.seal?.visible ?? [])], sealed: [...(tab?.seal?.sealed ?? [])], nodes: [...(tab?.seal?.nodes ?? [])] };
    };
    cdp675NativeRecord({ tabId, phase: name, outcome: 'start', method, params, ...state() });
    try {
      const result = await original.apply(this, args);
      const witness = read ? method === 'Page.getFrameTree' ? result : { frames: result.documents?.map(doc => result.strings?.[doc.frameId]) } : undefined;
      cdp675NativeRecord({ tabId, phase: name, outcome: 'success', method, witness, ...state() });
      return result;
    } catch (error) {
      cdp675NativeRecord({ tabId, phase: name, outcome: 'error', method, error: String(error?.message ?? error), stack: error?.stack ?? null, ...state() });
      throw error;
    }
  };
}
`;
}

export async function nativeTapFixture(directory) {
  const root = await mkdtemp(join(tmpdir(), 'cdp-675-native-tap-'));
  await cp(directory, root, { recursive: true });
  const file = join(root, 'cdp.js');
  const original = await readFile(file, 'utf8');
  const tapped = tapNativeSource(original);
  await writeFile(file, tapped);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(typeof manifest.key, 'string');
  const extensionId = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
  return {
    directory: root,
    extensionId,
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    tappedSha256: createHash('sha256').update(tapped).digest('hex'),
    scope: 'test-only native refusal trace, collected by raw observer, never guard output',
  };
}

export async function nativeTapRead(chrome, fixture, targetId, bounded) {
  const workers = (await chrome.cdp.send('Target.getTargets', {})).targetInfos.filter(
    (target) =>
      target.type === 'service_worker' &&
      target.url === `chrome-extension://${fixture.extensionId}/background.js`
  );
  assert.equal(workers.length, 1, 'native tap must use the owned candidate worker');
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: workers[0].targetId,
    flatten: true,
  });
  try {
    const result = await bounded(chrome, sessionId, 'Runtime.evaluate', {
      expression: `({installed: Array.isArray(globalThis.cdp675NativeTrace), records: (globalThis.cdp675NativeTrace ?? []).filter(record => String(record.tabId) === ${JSON.stringify(String(targetId))})})`,
      returnByValue: true,
    });
    assert.equal(
      result.result?.value?.installed,
      true,
      'native refusal observer was not installed'
    );
    return result.result.value;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  }
}
