import { env } from 'node:process';
import {
  globalSetup,
  hotspots,
  report,
} from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/global.mjs';

export { globalSetup };

export async function globalTeardown() {
  if (env.SLICC_COVERAGE === '1') await report();
  await hotspots();
}
