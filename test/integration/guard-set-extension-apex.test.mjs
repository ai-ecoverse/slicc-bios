import { shared } from './guard-set.mjs';

shared('extension', { group: 'apex', except: ['lagging'] });
