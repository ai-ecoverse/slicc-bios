import { shared } from './guard-set.mjs';

shared('link', { group: 'apex', except: ['lagging'] });
