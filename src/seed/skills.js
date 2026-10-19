import { text } from './update.js';

export const SKILLS = '/usr/share/skills';
export const BUILTIN = '/var/lib/slicc/agent/skills';

export const record = (id) => `var/lib/slicc/optional/${id}/skills`;

const LINK = [
  'pkg=$1; rec=$2; home=$3; to=$4; builtin=$5; shift 5',
  '[ $# -gt 0 ] || [ -f "$rec" ] || exit 0',
  'real=$(realpath -e "$pkg") || { echo "skipped all: no package at $pkg"; exit 0; }',
  'home=$(realpath -e "$home") || { echo "skipped all: no $home"; exit 0; }',
  'mkdir -p "$to" "${rec%/*}" || exit 1',
  'new="$rec.new"; : > "$new" || exit 1',
  'for e in "$@"; do',
  '  e=${e#./}',
  '  case "/$e/" in //*|*/../*|*/./*|*\\\\*) echo "skipped $e: not a path inside the package"; continue ;; esac',
  '  d=$(realpath -e "$real/$e" 2>/dev/null) || { echo "skipped $e: missing"; continue; }',
  '  case "$d/" in "$real/"*) ;; *) echo "skipped $e: leaves the package"; continue ;; esac',
  '  for s in "$d"/*; do',
  '    [ -f "$s/SKILL.md" ] || continue',
  '    n=${s##*/}',
  '    t=$(realpath -e "$s") || continue',
  '    case "$t/" in "$real/"*) ;; *) echo "skipped $n: leaves the package"; continue ;; esac',
  '    case "$t/" in "$home/"*) ;; *) echo "skipped $n: not under $home"; continue ;; esac',
  '    printf "%s\\n" "$n" | grep -qxE "[a-z0-9][a-z0-9-]*" || { echo "skipped $n: not a skill name"; continue; }',
  '    f=$(sed -n "1{/^---[[:space:]]*\\$/!q;};2,/^---[[:space:]]*\\$/{s/^name:[[:space:]]*//p;}" "$t/SKILL.md" | head -1 | tr -d "\\"\' \\r")',
  '    [ "$f" = "$n" ] || { echo "skipped $n: its SKILL.md names ${f:-nothing}"; continue; }',
  '    [ -e "$builtin/$n" ] && { echo "skipped $n: a built-in skill"; continue; }',
  '    grep -qxF "$n" "$new" && continue',
  '    l=$to/$n',
  '    if [ -e "$l" ] || [ -L "$l" ]; then',
  '      { [ -L "$l" ] && grep -qxF "$n" "$rec" 2>/dev/null; } || { echo "skipped $n: $l is taken"; continue; }',
  '    fi',
  '    chmod -R a+rX "$t" || exit 1',
  '    p=${t%/*}; while [ "${#p}" -gt "${#home}" ]; do chmod a+x "$p" || exit 1; p=${p%/*}; done',
  '    ln -sfn "$t" "$l" || exit 1',
  '    echo "$n" >> "$new"; echo "linked $n"',
  '  done',
  'done',
  'if [ -f "$rec" ]; then',
  '  while IFS= read -r o; do',
  '    case "$o" in ""|*/*|.*|-*) continue ;; esac',
  '    grep -qxF "$o" "$new" && continue',
  '    [ -L "$to/$o" ] && rm -f "$to/$o" && echo "unlinked $o"',
  '  done < "$rec"',
  'fi',
  'if [ -s "$new" ]; then mv -f "$new" "$rec"; else rm -f "$new" "$rec"; fi',
].join('\n');

const UNLINK = [
  'rec=$1; to=$2',
  '[ -f "$rec" ] || exit 0',
  'while IFS= read -r o; do',
  '  case "$o" in ""|*/*|.*|-*) continue ;; esac',
  '  [ -L "$to/$o" ] && rm -f "$to/$o" && echo "unlinked $o"',
  'done < "$rec"',
  'rm -f "$rec"',
].join('\n');

async function bash(kernel, script, args) {
  let out = '';
  const { status, stderr } = await kernel.run(['bash', '-c', script, 'skills', ...args], {
    cwd: '/',
    onStdout: (chunk) => {
      out += chunk;
    },
  });
  if (status) throw new Error(stderr?.trim() || `exited with ${status}`);
  return out.split('\n').filter(Boolean);
}

function report(id, lines) {
  for (const line of lines)
    if (line.startsWith('skipped')) console.warn(`bios skills: ${id}: ${line}`);
  return lines;
}

export async function linkSkills({ root, kernel, global, entry, dir }) {
  try {
    const at = `${dir}/node_modules/${entry.package}`;
    const manifest = JSON.parse((await text(root, `${at}/package.json`)) ?? '{}');
    const skills = Array.isArray(manifest?.pi?.skills) ? manifest.pi.skills : [];
    const home = `/${global.replace(/\/global\/v\d+$/, '')}`;
    const args = [
      `/${at}`,
      `/${record(entry.id)}`,
      home,
      SKILLS,
      BUILTIN,
      ...skills.filter((s) => typeof s === 'string'),
    ];
    return report(entry.id, await bash(kernel, LINK, args));
  } catch (error) {
    console.warn(`bios skills: ${entry.id}: ${error.message}`);
    return [];
  }
}

export async function unlinkSkills({ kernel, entry }) {
  try {
    return await bash(kernel, UNLINK, [`/${record(entry.id)}`, SKILLS]);
  } catch (error) {
    console.warn(`bios skills: ${entry.id}: ${error.message}`);
    return [];
  }
}
