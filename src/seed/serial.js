import { plugged, programOf, requesterOf, who } from './requests.js';

export const SERIAL_SWITCH = { key: 'serial', label: 'Serial ports' };
export const SERIAL_LABEL = 'Serial port open';

export function serialPrompts(devices) {
  return Object.fromEntries(
    Object.keys(devices.kinds).map((kind) => [kind, devices.prompts[kind] ?? (() => null)])
  );
}

export function serialClick(clicks) {
  return (request, prompt) => {
    if (request.kind !== 'serial.request' || !prompt) return null;
    const { stamp, signal } = request;
    return {
      ask: () =>
        clicks.ask({
          kind: 'device',
          detail: { what: 'serial', program: programOf(stamp) },
          asker: requesterOf(stamp),
          title: prompt.title,
          body: prompt.body,
          action: prompt.action,
          dismissed: prompt.dismissed,
          signal,
          stamp,
        }),
      open: () => ({ signal, reply: (reply) => reply, done() {} }),
    };
  };
}

export function serialLive(ports, live) {
  const shown = new Map();
  const remove = (handle) => {
    shown.get(handle)?.();
    shown.delete(handle);
  };
  return ports.watch((event) => {
    remove(event.handle);
    if (event.type !== 'open') return;
    shown.set(
      event.handle,
      live.add({
        kind: 'serial',
        label: SERIAL_LABEL,
        what: event.handle,
        asker: who(event.stamp),
        since: event.since,
        action: { label: 'Close', run: () => ports.close(event.handle) },
      })
    );
  });
}

export function serialPorts({ create, switches, clicks, live }) {
  let toggle = null;
  const devices = create({ enabled: () => toggle.on() });
  toggle = switches.add({ ...SERIAL_SWITCH, off: () => devices.ports.closeAll() });
  serialLive(devices.ports, live);
  return {
    kinds: devices.kinds,
    handlers: plugged(devices, serialPrompts(devices), undefined, serialClick(clicks)),
  };
}
