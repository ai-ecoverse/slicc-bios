import { shared } from './guard-set.mjs';

shared('devtools', { group: 'vault-x', except: ['lagging'] });
