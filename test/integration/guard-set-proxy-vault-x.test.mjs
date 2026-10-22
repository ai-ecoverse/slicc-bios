import { shared } from './guard-set.mjs';

shared('proxy', { group: 'vault-x', except: ['lagging'] });
