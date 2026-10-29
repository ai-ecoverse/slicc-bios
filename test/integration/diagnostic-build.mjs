import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const [stage, cwd, command, ...args] = process.argv.slice(2);
const errors = [];
const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
child.stdout.on('data', () => {});
child.stderr.on('data', (chunk) => {
  tail += chunk.toString();
  const lines = tail.split('\n');
  tail = lines.pop();
  for (const line of lines) {
    const code = /^error\[(E\d+)\]/.exec(line);
    const file = /^\s*--> (crates\/[a-z-]+\/src\/[a-z_]+\.rs):(\d+):(\d+)/.exec(line);
    if (code) errors.push({ code: code[1] });
    if (file) errors.push({ file: file[1], line: Number(file[2]), column: Number(file[3]) });
  }
});
const code = await new Promise((resolve) => {
  child.once('error', () => resolve(127));
  child.once('exit', (code) => resolve(code ?? 128));
});
const root = `${process.env.GITHUB_WORKSPACE ?? process.cwd()}/diagnostic-artifacts`;
await mkdir(root, { recursive: true });
await writeFile(
  `${root}/build-${stage}.jsonl`,
  JSON.stringify({ layer: 'build', stage, code, errors }) + '\n'
);
console.log(`diagnostic build ${stage}: exit ${code}`);
process.exitCode = code;
