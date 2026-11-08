import { shared } from './guard-set.mjs';

shared('devtools', { group: 'vault', except: ['lagging'] });
