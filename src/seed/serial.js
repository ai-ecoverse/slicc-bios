import { plugged, programOf, requesterOf, who } from './requests.js';
import { USB_SWITCH, usbLive } from './usb.js';

export const SERIAL_SWITCH = { key: 'serial', label: 'Serial ports' };
export const SERIAL_LABEL = 'Serial port open';

export function serialPrompts(devices) {
  return Object.fromEntries(
    Object.keys(devices.kinds).map((kind) => [kind, devices.prompts[kind] ?? (() => null)])
  );
}

export function deviceClick(clicks, kind, what) {
  return (request, prompt) => {
    if (request.kind !== kind || !prompt) return null;
    const { stamp, signal } = request;
    return {
      ask: () =>
        clicks.ask({
          kind: 'device',
          detail: { what, program: programOf(stamp) },
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

export const serialClick = (clicks) => deviceClick(clicks, 'serial.request', 'serial');
export const usbClick = (clicks) => deviceClick(clicks, 'usb.request', 'usb');

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
        what: event.node ? `${event.handle} (${event.node})` : event.handle,
        asker: who(event.stamp),
        since: event.since,
        action: { label: 'Close', run: () => ports.close(event.handle) },
      })
    );
  });
}

export function serialPorts({ create, switches, clicks, live }) {
  let toggle = null;
  let usb = null;
  const devices = create({ enabled: () => toggle.on(), usbEnabled: () => usb.on() });
  toggle = switches.add({ ...SERIAL_SWITCH, off: () => devices.ports.closeAll() });
  usb = switches.add({ ...USB_SWITCH, off: () => devices.devices.usb.closeAll() });
  serialLive(devices.ports, live);
  usbLive(devices.devices.usb, live);
  const serialGuard = serialClick(clicks);
  const usbGuard = usbClick(clicks);
  const guard = (request, prompt) => serialGuard(request, prompt) ?? usbGuard(request, prompt);
  return {
    kinds: devices.kinds,
    handlers: plugged(devices, serialPrompts(devices), undefined, guard),
    devices: { open: (request) => devices.devices.open(request) },
    nodes(kernel) {
      try {
        return devices.devices.nodes(kernel);
      } catch (error) {
        console.warn(`serial nodes: ${error.message}`);
        return null;
      }
    },
  };
}
