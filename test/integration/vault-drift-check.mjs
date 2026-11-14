import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PREVIEW = 'https://vault-preview.sliccy.ai';
const PACKAGE = '@ai-ecoverse/slicc-vault';

export function stripFrameAncestors(csp) {
  return String(csp).replace(/frame-ancestors[^;]*/, 'frame-ancestors <dynamic>');
}

export function probesForSite(site) {
  const probes = [
    ['/', 'documents'],
    ['/frame.js', 'scripts'],
    ['/fonts/AdobeClean-Regular.woff2', 'fonts'],
  ];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.name.endsWith('.wasm')) probes.push([`/${rel}`, 'wasm']);
    }
  };
  walk(site);
  return probes;
}

export async function compareLiveHeaders({ root = process.cwd(), fetchImpl = fetch } = {}) {
  const site = join(root, 'node_modules', PACKAGE, 'dist/site');
  const doc = JSON.parse(
    readFileSync(join(root, 'node_modules', PACKAGE, 'dist/headers.json'), 'utf8')
  );
  const probes = probesForSite(site);
  const diffs = [];
  for (const [path, name] of probes) {
    const expected = doc.classes[name]?.headers;
    if (!expected) {
      diffs.push(`${path}: no class ${name} in headers.json`);
      continue;
    }
    const response = await fetchImpl(new URL(path, PREVIEW));
    if (!response.ok) {
      diffs.push(`${path}: live status ${response.status}`);
      continue;
    }
    for (const [header, want] of Object.entries(expected)) {
      const got = response.headers.get(header);
      if (got == null) {
        diffs.push(`${path}: missing ${header}`);
        continue;
      }
      const left = header === 'content-security-policy' ? stripFrameAncestors(got) : got;
      const right = header === 'content-security-policy' ? stripFrameAncestors(want) : want;
      if (left !== right)
        diffs.push(
          `${path}: ${header}: live ${JSON.stringify(got)} != pin ${JSON.stringify(want)}`
        );
    }
  }
  return { probes, diffs };
}

function fileIssue(title, body) {
  writeFileSync('vault-drift-body.md', body);
  const listed = spawnSync(
    'gh',
    [
      'issue',
      'list',
      '--state',
      'open',
      '--search',
      'in:title "vault drift:"',
      '--json',
      'number,title',
      '--jq',
      '[.[] | select(.title | startswith("vault drift:"))] | .[0].number // empty',
    ],
    { encoding: 'utf8' }
  );
  const existing = listed.stdout.trim();
  if (existing) {
    spawnSync(
      'gh',
      ['issue', 'edit', existing, '--title', title, '--body-file', 'vault-drift-body.md'],
      {
        stdio: 'inherit',
      }
    );
    spawnSync('gh', ['issue', 'comment', existing, '--body', 'Still drifting: headers differ.'], {
      stdio: 'inherit',
    });
    return;
  }
  spawnSync('gh', ['issue', 'create', '--title', title, '--body-file', 'vault-drift-body.md'], {
    stdio: 'inherit',
  });
}

async function main() {
  const { probes, diffs } = await compareLiveHeaders();
  if (diffs.length === 0) {
    console.log(
      'vault-preview headers match headers.json classes for',
      probes.map(([path]) => path).join(', ')
    );
    process.exit(0);
  }
  console.error('::error::vault drift: headers differ');
  for (const line of diffs) console.error(line);
  fileIssue(
    'vault drift: headers differ',
    [
      'Live https://vault-preview.sliccy.ai response headers differ from the pinned `@ai-ecoverse/slicc-vault` `dist/headers.json` class headers (`frame-ancestors` compared after normalizing).',
      '',
      ...diffs.map((line) => `- ${line}`),
      '',
      'Bump the vault pin, or fix the preview deploy / headers.json.',
      '',
    ].join('\n')
  );
  process.exit(1);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) await main();
