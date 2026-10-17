import { spawn } from 'node:child_process';

export const HOST_CDP = Array.from({ length: 8 }, (_, i) => 9222 + i);

export const cliEnv = (env = process.env) => ({ ...env, SLICC_DISCOVERY: 'isolated' });

export function attach(cli, args, options = {}) {
  return spawn(cli, ['attach', ...args], {
    ...options,
    env: cliEnv(options.env),
  });
}
