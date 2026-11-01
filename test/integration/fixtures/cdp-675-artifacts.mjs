import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
const cdp = 'ai-ecoverse-slicc-cdp-1.43.2.tgz';
const mcpcat = 'ai-ecoverse-mcpcat-0.80.1.tgz';
const oldClient = 'ai-ecoverse-slicc-cdp-1.43.1.tgz';
const wasm = execFileSync(
  'tar',
  ['-xOzf', join(directory, cdp), 'package/bin/playwright-cli.wasm'],
  {
    maxBuffer: 64 * 1024 * 1024,
  }
);
const sum = (data) => createHash('sha256').update(data).digest('hex');
assert.equal(sum(wasm), sum(await readFile('candidates/cdp/bin/playwright-cli.wasm')));
const head = (where) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: where, encoding: 'utf8' }).trim();
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      heads: {
        bios: head('.'),
        cdp: head('candidates/cdp'),
        mcpcat: head('candidates/mcpcat'),
        extension: head('candidates/extension'),
        cli: head('candidates/cli'),
        browsers: head('candidates/browsers'),
      },
      diagnosticVersions: { cdp: '1.43.2', mcpcat: '0.80.1', extension: '7.11.1', cli: '1.49.37' },
      cdp,
      mcpcat,
      oldClient,
      oldClientWasmSha256: sum(
        execFileSync(
          'tar',
          ['-xOzf', join(directory, oldClient), 'package/bin/playwright-cli.wasm'],
          { maxBuffer: 64 * 1024 * 1024 }
        )
      ),
      wasmSha256: sum(wasm),
      packageSha256: {
        cdp: sum(await readFile(join(directory, cdp))),
        mcpcat: sum(await readFile(join(directory, mcpcat))),
      },
    },
    null,
    2
  )
);
