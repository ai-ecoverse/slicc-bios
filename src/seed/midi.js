import { deviceLive } from './usb.js';

export const MIDI_SWITCH = { key: 'midi', label: 'MIDI devices' };
export const MIDI_LABEL = 'MIDI port open';

export const midiWhat = (handle, info) => (info?.name ? `${handle} (${info.name})` : handle);

export const midiLive = (midi, live) =>
  deviceLive(midi, live, { kind: 'midi', label: MIDI_LABEL, what: midiWhat });
