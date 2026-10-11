import { fetchText, pnpm, text, write } from './update.js';

export const FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const RACE = /ERR_PNPM_CMD_SHIM_PARSE_MANIFEST/;

export const folder = (id) => `opt/slicc/${id}`;
export const receipt = (id) => `var/lib/slicc/optional/${id}/package.json`;
export const pthName = (id) => `slicc-${id}.pth`;

export async function loadProject(id, from) {
  const files = {};
  for (const name of FILES) files[name] = await fetchText(`projects/${id}/${name}`, from);
  const manifest = JSON.parse(files['package.json']);
  return { files, name: manifest.name, version: manifest.version };
}

export async function projectVersion(root, id) {
  return JSON.parse((await text(root, receipt(id))) ?? '{}').version ?? null;
}

async function handle(dir, path, create = false) {
  for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function entries(dir) {
  const found = [];
  for await (const child of dir.values()) found.push(child);
  return found;
}

export async function sitePackages(root, id) {
  const base = `${folder(id)}/node_modules`;
  const found = [];
  let scopes;
  try {
    scopes = await entries(await handle(root, base));
  } catch {
    return found;
  }
  for (const scope of scopes.filter((child) => child.kind === 'directory')) {
    const names = scope.name.startsWith('@')
      ? (await entries(scope))
          .filter((child) => child.kind === 'directory')
          .map((child) => `${scope.name}/${child.name}`)
      : [scope.name];
    for (const name of names) {
      const manifest = JSON.parse((await text(root, `${base}/${name}/package.json`)) ?? '{}');
      const site = manifest.slicc?.python?.sitePackages;
      if (site) found.push({ name, site });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writePth(root, id) {
  const found = await sitePackages(root, id);
  if (!found.length) return null;
  const lines = found.map(({ name, site }) => `/${folder(id)}/node_modules/${name}/${site}`);
  const path = `root/.local/${found[0].site}/${pthName(id)}`;
  await write(root, path, `${lines.join('\n')}\n`);
  return path;
}

async function removeIn(root, path) {
  const names = path.split('/');
  const name = names.pop();
  try {
    await (await handle(root, names.join('/'))).removeEntry(name, { recursive: true });
  } catch {}
}

export async function installProject({ root, kernel, id, project, report, to }) {
  for (const name of FILES) await write(root, `${folder(id)}/${name}`, project.files[name]);
  await pnpm(kernel, `/${folder(id)}`, report, to).catch((error) => {
    if (!RACE.test(error.log)) throw error;
    return pnpm(kernel, `/${folder(id)}`, report, to);
  });
  const pth = await writePth(root, id);
  await write(
    root,
    receipt(id),
    `${JSON.stringify({ name: project.name, version: project.version, pth })}\n`
  );
}

export async function removeProject(root, id) {
  const pth = JSON.parse((await text(root, receipt(id))) ?? '{}').pth;
  if (pth) await removeIn(root, pth);
  await removeIn(root, folder(id));
  await removeIn(root, receipt(id));
}
