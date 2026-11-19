import { deviceLive } from './usb.js';

export const HID_SWITCH = { key: 'hid', label: 'HID devices' };
export const HID_LABEL = 'HID device open';

export const hidLive = (hid, live) => deviceLive(hid, live, { kind: 'hid', label: HID_LABEL });
