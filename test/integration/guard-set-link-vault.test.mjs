import { shared } from './guard-set.mjs';

shared('link', { group: 'vault', except: ['lagging'] });
