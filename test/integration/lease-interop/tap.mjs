const decoder = new TextDecoder('utf-8', { fatal: true });
const allowed = new Set(['proof', 'pending', 'grant', 'ready', 'action', 'result', 'error']);

function frames(observe) {
  let rest = new Uint8Array();
  return (chunk) => {
    const bytes = new Uint8Array(rest.byteLength + chunk.byteLength);
    bytes.set(rest);
    bytes.set(chunk, rest.length);
    let i = 0;
    while (i + 4 <= bytes.length) {
      const n = new DataView(bytes.buffer).getUint32(i);
      if (n === 0 || n > 65536) throw new Error('Invalid lease record size');
      if (i + 4 + n > bytes.length) break;
      observe(JSON.parse(decoder.decode(bytes.subarray(i + 4, i + 4 + n))));
      i += 4 + n;
    }
    rest = bytes.slice(i);
  };
}

export function measuredJob(job, counts, change) {
  const peers = new WeakMap();
  const inc = (name) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const see = (direction, mode, r) => {
    let type = allowed.has(r?.type) ? r.type : 'unexpected';
    if (type === 'action')
      type = ['goto', 'snapshot', 'click', 'fill'].includes(r.op) ? r.op : 'unexpected';
    inc(`${direction}.${mode}.${type}`);
  };
  return {
    attach(session) {
      const measured = {
        close: (why) => session.close(why),
        async open(meta) {
          const mode =
            meta.kind === 'cdp-lease-v1' && ['request', 'data'].includes(meta.mode)
              ? meta.mode
              : 'unexpected';
          inc(`open.${mode}`);
          if (
            mode === 'data' &&
            typeof meta.jwt === 'string' &&
            /^[\w-]+\.[\w-]+\.[\w-]{86}$/.test(meta.jwt)
          )
            inc('dataWithJws');
          const stream = await session.open(meta);
          if (typeof stream.info.nonce === 'string' && /^[\w-]{43}$/.test(stream.info.nonce))
            inc(`challenge.${mode}`);
          const inwards = frames((r) => see('in', mode, r)),
            outwards = frames((r) => see('out', mode, r));
          return {
            info: stream.info,
            settled: stream.settled,
            close: () => stream.close(),
            closeWrite: () => stream.closeWrite(),
            async read() {
              const bytes = await stream.read();
              if (bytes) inwards(bytes);
              return bytes;
            },
            write(bytes) {
              outwards(bytes);
              return stream.write(bytes);
            },
          };
        },
      };
      peers.set(session, measured);
      job.attach(measured);
      inc('attach');
      change();
    },
    detach(session) {
      job.detach(peers.get(session));
      peers.delete(session);
      inc('detach');
      change();
    },
  };
}
