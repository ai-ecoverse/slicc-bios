import { spawn } from 'node:child_process';

export const HOST_CDP = Array.from({ length: 8 }, (_, i) => 9222 + i);

export const shield = (ports = []) =>
  ['127.0.0.0/8', '[::1]/128']
    .flatMap((host) => [...HOST_CDP, ...ports].map((port) => `${host}:${port}`))
    .join(',');

export const cliEnv = (env = process.env) => ({ ...env, SLICC_DISCOVERY: 'isolated' });

export function attach(cli, args, options = {}, ports = []) {
  return spawn(cli, ['attach', '--deny', shield(ports), ...args], {
    ...options,
    env: cliEnv(options.env),
  });
}
