export const MARKER = ['.slicc', 'agent-profile.json'];
export const STARTED = 'slicc-os.agent-schema';
export const KNOWN = 2;
export const OLDER =
  'This profile was opened by a newer agent, and its sessions can’t be opened by the agent seven runs now. Seven didn’t start it. Turn on Developer mode and install the newer agent from Install / Update, or wait until seven ships it.';

export function schemaOf(version) {
  const major = Number(String(version ?? '').split('.')[0]);
  return Number.isInteger(major) && major >= 7 ? 2 : 1;
}

async function marker(root) {
  let data;
  try {
    const dir = await root.getDirectoryHandle(MARKER[0]);
    data = await (await (await dir.getFileHandle(MARKER[1])).getFile()).text();
  } catch (error) {
    return error?.name === 'NotFoundError' ? 0 : KNOWN;
  }
  try {
    const schema = JSON.parse(data)?.durableSchema;
    return Number.isInteger(schema) && schema >= 1 ? schema : KNOWN;
  } catch {
    return KNOWN;
  }
}

export async function profileSchema(root, storage = globalThis.localStorage) {
  const kept = Number(storage?.getItem(STARTED) ?? 0) || 0;
  return Math.max(kept, await marker(root));
}

export async function mayStart(version, { root, storage = globalThis.localStorage } = {}) {
  const wanted = schemaOf(version);
  if (wanted < (await profileSchema(root, storage)))
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
