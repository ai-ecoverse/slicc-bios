export const PEER_TRACE = `() => {
  const start = performance.now();
  const at = () => Math.round(performance.now() - start);
  const log = (globalThis.peerTrace = { closes: [], control: [] });
  const note = (event, detail = '') => log.control.push(at() + ' ' + event + (detail ? ' ' + detail : ''));
  const brief = (data) => (typeof data === 'string' ? data.slice(0, 120) : 'binary ' + (data.byteLength ?? data.size ?? 0));
  const watch = (channel, how) => {
    if (channel.label !== 'slicc.link.v1') return channel;
    note(how, channel.readyState);
    const send = channel.send;
    channel.send = function (data) {
      note('send', brief(data));
      return send.call(this, data);
    };
    channel.addEventListener('open', () => note('open'));
    channel.addEventListener('message', ({ data }) => note('message', brief(data)));
    channel.addEventListener('close', () => note('close'));
    return channel;
  };
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    return watch(create.apply(this, args), 'created');
  };
  const listen = RTCPeerConnection.prototype.addEventListener;
  RTCPeerConnection.prototype.addEventListener = function (type, listener, options) {
    if (type !== 'datachannel') return listen.call(this, type, listener, options);
    return listen.call(this, type, (event) => {
      watch(event.channel, 'announced');
      return listener.call(this, event);
    }, options);
  };
  const close = RTCPeerConnection.prototype.close;
  RTCPeerConnection.prototype.close = function () {
    log.closes.push(at() + ' ' + new Error('close').stack.split('\\n').slice(2, 9).map((line) => line.trim()).join(' < '));
    return close.call(this);
  };
}`;

export async function peerTrace(roles) {
  const lines = [];
  for (const [role, page] of Object.entries(roles)) {
    const trace = await page
      .evaluate(() => globalThis.peerTrace ?? null)
      .catch((error) => ({ error: error.message }));
    lines.push(`${role} closed a peer connection: ${JSON.stringify(trace?.closes ?? trace)}`);
    lines.push(`${role} control channels:`, ...(trace?.control ?? []).map((line) => `  ${line}`));
  }
  return lines.join('\n');
}
