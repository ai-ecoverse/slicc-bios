import { shared } from './guard-set.mjs';

shared('extension', { group: 'vault-x', except: ['lagging'] });
