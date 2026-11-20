import { who } from './requests.js';

export const USB_SWITCH = { key: 'usb', label: 'USB devices' };
export const USB_LABEL = 'USB device open';

const hex = (id) =>
  `0x${Number(id ?? 0)
    .toString(16)
    .padStart(4, '0')}`;

export function usbWhat(handle, info) {
  if (!info) return handle;
  const ids = `${hex(info.vendorId)}:${hex(info.productId)}`;
  return `${handle} (${info.productName ? `${ids} ${info.productName}` : ids})`;
}

export function deviceLive(source, live, { kind, label, what = usbWhat }) {
  const shown = new Map();
  return source.watch((event) => {
    if (event.type !== 'open' && event.type !== 'close') return;
    shown.get(event.handle)?.();
    shown.delete(event.handle);
    if (event.type !== 'open') return;
    shown.set(
      event.handle,
      live.add({
        kind,
        label,
        what: what(event.handle, event.info),
        asker: who(event.stamp),
        since: event.since,
        action: { label: 'Close', run: () => source.close(event.handle) },
      })
    );
  });
}

export const usbLive = (usb, live) => deviceLive(usb, live, { kind: 'usb', label: USB_LABEL });
