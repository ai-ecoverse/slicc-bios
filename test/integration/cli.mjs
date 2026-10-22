import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOST_CDP = Array.from({ length: 8 }, (_, i) => 9222 + i);

const LOCAL = fileURLToPath(new URL('../../node_modules/.bin/slicc', import.meta.url));

export const CLI = process.env.SLICC_CLI || (existsSync(LOCAL) ? LOCAL : undefined);

export const cliEnv = (env = process.env) => ({
  SLICC_NO_UPDATE_CHECK: '1',
  ...env,
  SLICC_DISCOVERY: 'isolated',
});

export function attach(cli, args, options = {}) {
  return spawn(cli, ['attach', ...args], {
    ...options,
    env: cliEnv(options.env),
  });
}
