import { deviceLive } from './usb.js';

export const BLE_SWITCH = { key: 'ble', label: 'Bluetooth devices' };
export const BLE_LABEL = 'Bluetooth device connected';

export const bleWhat = (handle, info) => (info?.name ? `${handle} (${info.name})` : handle);

export const bleLive = (ble, live) =>
  deviceLive(ble, live, { kind: 'ble', label: BLE_LABEL, what: bleWhat });
