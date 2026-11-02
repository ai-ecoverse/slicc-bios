import assert from 'node:assert/strict';

export function ownedRowPids(target, serverOutput, log) {
  const server = Number(serverOutput.trim());
  assert.ok(Number.isSafeInteger(server) && server > 1, 'owned server PID is required');
  const holders = log.split('\n').flatMap((line) => {
    const match = line.match(/holder-pid (\d+) tab (\S+)$/);
    return match && match[2] === target ? [Number(match[1])] : [];
  });
  assert.ok(holders.length <= 1, 'one owned holder identity is required');
  assert.ok(holders.every((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== server));
  return [server, ...holders];
}

export async function awaitRowClosure(page, row, boundMs = 5000) {
  assert.ok(row?.ownedPids?.length, 'previous row needs exact owned process identities');
  assert.ok(row.guardConnections?.length, 'previous row needs its guard connection identities');
  assert.ok(row.ownedPids.every((pid) => Number.isSafeInteger(pid) && pid > 1));
  assert.ok(row.guardConnections.every((id) => Number.isSafeInteger(id) && id > 0));
  await page.within(
    boundMs,
    async ({ pids, connections }) => {
      if (!connections.every((id) => globalThis.cdp675Connections?.get(id)?.closedAt !== undefined))
        return false;
      globalThis.cdp675Client ??= await globalThis.sliccKernelClient();
      const command = pids.map((pid) => `test ! -e /proc/${pid}/stat`).join(' && ');
      const reply = await globalThis.cdp675Client.run(['bash', '-c', command], { cwd: '/' });
      return reply.status === 0;
    },
    { pids: row.ownedPids, connections: row.guardConnections }
  );
  return {
    previousRow: row.name,
    pids: row.ownedPids,
    connections: row.guardConnections,
    boundMs,
    completedAt: Date.now(),
  };
}
