let mode = 'ack';
let applied = { needed: false, version: 0, ready: true };
let receipts = 0;
const held = [];

function apply(pair) {
  applied = { ...pair };
  postMessage({ applied });
}

function answer(entry, replacement) {
  const { pair, request, port } = entry;
  apply(pair);
  const reply = replacement ?? { v: 1, nonce: request.nonce, version: request.version };
  if (mode === 'global') postMessage(reply);
  else if (mode === 'nonce') port.postMessage({ ...reply, nonce: '0'.repeat(32) });
  else if (mode === 'version') port.postMessage({ ...reply, version: reply.version + 1 });
  else if (mode === 'protocol') port.postMessage({ ...reply, v: 2 });
  else if (mode === 'extra') port.postMessage({ ...reply, extra: true });
  else if (mode === 'extra-port') {
    const channel = new MessageChannel();
    port.postMessage(reply, [channel.port2]);
    channel.port1.close();
  } else port.postMessage(reply);
  port.close();
}

addEventListener('message', ({ data, ports }) => {
  if (data.inspect) {
    ports[0].postMessage({ applied, receipts, held: held.length });
    ports[0].close();
    return;
  }
  if (data.mode) {
    mode = data.mode;
    ports[0]?.postMessage({ configured: true });
    ports[0]?.close();
    return;
  }
  if (data.release) {
    for (const entry of held.splice(0)) answer(entry, data.reply);
    return;
  }
  if (data.scrubReceipt) {
    receipts += 1;
    const entry = { pair: data.scrub, request: data.scrubReceipt, port: ports[0] };
    postMessage({ receipt: data.scrubReceipt });
    if (['hold', 'old', 'closed'].includes(mode) || (mode === 'hold-second' && receipts > 1)) {
      if (mode === 'closed') entry.port.close();
      else held.push(entry);
      return;
    }
    answer(entry);
    return;
  }
  data.vault?.close();
  if (data.scrub && mode !== 'hold' && !(mode === 'hold-second' && receipts > 0)) apply(data.scrub);
});

postMessage({ ready: true });
