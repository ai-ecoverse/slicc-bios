export const MARKER = ['.slicc', 'agent-profile.json'];
export const STARTED = 'slicc-os.agent-schema';
export const STARTED_BY = 'slicc-os.agent-schema-by';
export const KNOWN = 2;
const SCHEMAS = new Map([
  [7, KNOWN],
  [8, KNOWN],
]);
export const OLDER =
  'This profile was opened by a newer agent, and its sessions can’t be opened by the agent seven runs now. Seven didn’t start it. Turn on Developer mode and install the newer agent from Install / Update, or wait until seven ships it.';

export const UNRECORDED =
  'Seven couldn’t record this agent’s profile version (storage full?), so it didn’t start it.';

export function schemaOf(version) {
  const major = Number(String(version ?? '').split('.')[0]);
  if (!Number.isInteger(major) || major < 7) return 1;
  return SCHEMAS.get(major) ?? Number.POSITIVE_INFINITY;
}

const capped = (schema) => Math.min(schema, KNOWN + 1);

async function marker(root) {
  let data;
  try {
    const dir = await root.getDirectoryHandle(MARKER[0]);
    data = await (await (await dir.getFileHandle(MARKER[1])).getFile()).text();
  } catch (error) {
    return error?.name === 'NotFoundError' ? { schema: 0 } : { schema: KNOWN };
  }
  try {
    const schema = JSON.parse(data)?.durableSchema;
    if (Number.isInteger(schema) && schema >= 1) return { schema, read: true };
  } catch {}
  return { schema: KNOWN };
}

function startedBy(storage, raw) {
  try {
    const by = JSON.parse(storage?.getItem(STARTED_BY) ?? 'null');
    return by?.schema === raw && typeof by.agent === 'string' ? by.agent : null;
  } catch {
    return null;
  }
}

function record(storage, found) {
  const raw = Number(storage?.getItem(STARTED) ?? 0) || 0;
  const by = startedBy(storage, raw);
  if (by !== null) return { raw, by, kept: Math.min(raw, capped(schemaOf(by))) };
  if (raw > KNOWN && found.read) return { raw, by, kept: 0 };
  return { raw, by, kept: raw };
}

function write(storage, schema, agent) {
  storage.setItem(STARTED_BY, JSON.stringify({ schema, agent }));
  storage.setItem(STARTED, String(schema));
}

export async function profileSchema(root, storage = globalThis.localStorage) {
  const found = await marker(root);
  return Math.max(record(storage, found).kept, found.schema);
}

export async function mayStart(version, { root, storage = globalThis.localStorage } = {}) {
  const wanted = schemaOf(version);
  const found = await marker(root);
  const { raw, by, kept } = record(storage, found);
  if (wanted < Math.max(kept, found.schema))
    throw Object.assign(new Error(`agent ${version} is older than this profile`), {
      plain: OLDER,
      older: true,
    });
  if (wanted <= kept) {
    if (kept !== raw) {
      try {
        write(storage, kept, by);
      } catch {}
    }
    return;
  }
  try {
    write(storage, capped(wanted), version);
  } catch (error) {
    if (wanted > 1 && wanted > found.schema)
      throw Object.assign(new Error(`couldn't record schema ${wanted}: ${error.message}`), {
        plain: UNRECORDED,
        older: true,
      });
  }
}
