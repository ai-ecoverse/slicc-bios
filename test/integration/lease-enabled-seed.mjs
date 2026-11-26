import { registerHooks } from 'node:module';
import { leaseTestBuild } from './lease-test-build.mjs';

const gate = new URL('../../src/seed/lease-build.js', import.meta.url).href;
registerHooks({
  load(url, ctx, next) {
    return url === gate
      ? { format: 'module', source: leaseTestBuild, shortCircuit: true }
      : next(url, ctx);
  },
});
