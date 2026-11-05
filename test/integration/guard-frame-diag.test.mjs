process.env.GUARD_IDS = 'C9.frame-hidden';
process.env.GUARD_TARGETS = 'ordinary';
process.env.GUARD_VARIANTS = 'prompt';
process.env.GUARD_TRACE = '1';
process.env.GUARD_FRAME_DIAG = '1';

import { shared } from './guard-set.mjs';

shared('link', { except: ['lagging'] });
