export const MARKER = ['.slicc', 'agent-profile.json'];
export const STARTED = 'slicc-os.agent-schema';
export const KNOWN = 2;
export const OLDER =
  'This profile was opened by a newer agent, and its sessions can’t be opened by the agent seven runs now. Seven didn’t start it. Turn on Developer mode and install the newer agent from Install / Update, or wait until seven ships it.';

export const UNRECORDED =
  'Seven couldn’t record this agent’s profile version (storage full?), so it didn’t start it.';

export function schemaOf(version) {
  const major = Number(String(version ?? '').split('.')[0]);
  if (!Number.isInteger(major) || major < 7) return 1;
  return major === 7 ? KNOWN : Number.POSITIVE_INFINITY;
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
  const kept = Number(storage?.getItem(STARTED) ?? 0) || 0;
  const found = await marker(root);
  if (wanted < Math.max(kept, found))
    throw Object.assign(new Error(`agent ${version} is older than this profile`), {
      plain: OLDER,
      older: true,
    });
  if (wanted <= kept) return;
  try {
    storage.setItem(STARTED, String(Math.min(wanted, KNOWN + 1)));
  } catch (error) {
    if (wanted > 1 && wanted > found)
      throw Object.assign(new Error(`couldn't record schema ${wanted}: ${error.message}`), {
        plain: UNRECORDED,
        older: true,
      });
  }
}
