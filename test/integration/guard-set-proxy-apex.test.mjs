import { shared } from './guard-set.mjs';

shared('proxy', { group: 'apex', except: ['lagging'] });
