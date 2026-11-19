import { shared } from './guard-set.mjs';

shared('devtools', { group: 'idp', except: ['lagging'] });
