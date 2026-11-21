import { env } from 'node:process';
import { stockChain } from './remote-cdp-stock.mjs';

const rounds = Number(env.STRESS_ROUNDS ?? 30);
const budget = Date.now() + Number(env.STRESS_BUDGET_MIN ?? 90) * 60000;
const chains = (env.STRESS_CHAINS ?? 'tray,stdio').split(',');

for (let round = 1; round <= rounds; round += 1)
  for (const chain of chains)
    stockChain('extension', {
      chain,
      round,
      budget,
      show: round <= 2 ? 'evaluate after group 2' : undefined,
    });
