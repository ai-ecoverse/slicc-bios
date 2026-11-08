import { shared } from './guard-set.mjs';

shared('devtools', { group: 'rest', except: ['lagging'] });
