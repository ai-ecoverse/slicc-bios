import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../../../src/seed/guard.js', import.meta.url);
const source = readFileSync(file, 'utf8');
const lines = source.split('\n');
const via =
  "${(new Error().stack.match(/guard\\.js:\\d+/g) ?? []).slice(1, 7).map((at) => at.slice(9)).join('<')}";
const flat = (value) => `\${String(${value}).replace(/[[\\]]/g, '|')}`;
const breadcrumb = (line, label) => `nav.done || (nav.why ??= 's${line} ${label}');`;
const edits = [
  [
    1285,
    'message: UNGUARDED',
    `message: \`\${UNGUARDED} [g:1285 m=\${method} closed=\${this.closed}]\``,
  ],
  [1312, 'message: UNGUARDED', `message: \`\${UNGUARDED} [g:1312 m=\${method} timeout]\``],
  [2696, 'message: UNGUARDED', `message: \`\${UNGUARDED} [g:2696 refusePending via=${via}]\``],
  [3428, 'nav.settle(true);', `${breadcrumb(3428, 'retireProof')} nav.settle(true);`],
  [
    3479,
    '() => nav.settle(true)',
    `() => (${breadcrumb(3479, 'NAV_MS timer').slice(0, -1)}, nav.settle(true))`,
  ],
  [
    3521,
    ': UNGUARDED;',
    `: \`\${UNGUARDED} [g:3521 why=${flat('nav?.why')} cause=${flat('nav?.cause')} via=${via}]\`;`,
  ],
  [
    3527,
    'return nav.settle(true);',
    `return (${breadcrumb(3527, 'retired').slice(0, -1)}, nav.settle(true));`,
  ],
  [
    3529,
    'return nav.settle(true);',
    `return (${breadcrumb(3529, 'no session').slice(0, -1)}, nav.settle(true));`,
  ],
  [
    3549,
    'nav.settle(steps.some((step) => step.error));',
    "nav.settle(steps.some((step) => step.error) && (nav.done || (nav.why ??= `s3549 steps=${steps.map((step, at) => (step.error ? ['Fetch.enable', 'Network.enable', 'Network.setBypassServiceWorker', 'Page.enable'][at] : '')).filter(Boolean).join('+')}`), true));",
  ],
  [
    3589,
    'nav.settle(true);',
    "nav.why ??= nav.done ? 's3590 lost after settle' : 's3589 lost'; nav.settle(true);",
  ],
  [6612, 'return UNGUARDED;', `return \`\${UNGUARDED} [g:6612 m=\${method} placed]\`;`],
  [6613, 'return UNGUARDED;', `return \`\${UNGUARDED} [g:6613 m=\${method} reread]\`;`],
  [
    6672,
    'return UNGUARDED;',
    `return \`\${UNGUARDED} [g:6672 m=\${method} type=\${target?.type}]\`;`,
  ],
];
for (const [line, from, to] of edits) {
  const at = line - 1;
  if (!lines[at]?.includes(from))
    throw new Error(`guard.js:${line} does not contain ${from}: ${lines[at]?.trim()}`);
  lines[at] = lines[at].replace(from, to);
  process.stdout.write(`TAG guard.js:${line} ${lines[at].trim()}\n`);
}
const tagged = lines.join('\n');
writeFileSync(file, tagged);
const sha = (text) => createHash('sha256').update(text).digest('hex');
process.stdout.write(`TAG guard.js ${sha(source)} -> ${sha(tagged)}, ${lines.length} lines\n`);
