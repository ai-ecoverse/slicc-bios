import { text } from './update.js';

export const MARKER = '.slicc/agent-profile.json';
export const STARTED = 'slicc-os.agent-schema';
export const OLDER =
  'This profile was opened by a newer agent, and its sessions can’t be opened by the agent seven runs now. Seven didn’t start it. Install the newer agent again from Install / Update, or wait until seven ships it.';

export function schemaOf(version) {
  const major = Number(String(version ?? '').split('.')[0]);
  return Number.isInteger(major) && major >= 7 ? 2 : 1;
}

export async function profileSchema(root, storage = globalThis.localStorage) {
  const kept = Number(storage?.getItem(STARTED) ?? 0) || 0;
  const data = await text(root, MARKER);
  if (data === null) return kept;
  try {
    const schema = JSON.parse(data)?.durableSchema;
    if (!Number.isInteger(schema) || schema < 1) return Number.POSITIVE_INFINITY;
    return Math.max(kept, schema);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function mayStart(version, { root, storage = globalThis.localStorage } = {}) {
  const wanted = schemaOf(version);
  const profile = await profileSchema(root, storage);
  if (wanted < profile)
    throw Object.assign(new Error(`agent ${version} is older than this profile`), {
      plain: OLDER,
      older: true,
    });
  if (wanted > (Number(storage?.getItem(STARTED) ?? 0) || 0)) {
    try {
      storage?.setItem(STARTED, String(wanted));
    } catch {}
  }
}
