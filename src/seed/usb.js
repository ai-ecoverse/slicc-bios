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

export function usbLive(usb, live) {
  const shown = new Map();
  return usb.watch((event) => {
    if (event.type !== 'open' && event.type !== 'close') return;
    shown.get(event.handle)?.();
    shown.delete(event.handle);
    if (event.type !== 'open') return;
    shown.set(
      event.handle,
      live.add({
        kind: 'usb',
        label: USB_LABEL,
        what: usbWhat(event.handle, event.info),
        asker: who(event.stamp),
        since: event.since,
        action: { label: 'Close', run: () => usb.close(event.handle) },
      })
    );
  });
}
