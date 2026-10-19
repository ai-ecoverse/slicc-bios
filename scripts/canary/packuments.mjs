import { env } from 'node:process';
import { serveCandidates } from './override-pins.mjs';

if (env.SLICC_CANARY) await serveCandidates(env.SLICC_CANARY);
