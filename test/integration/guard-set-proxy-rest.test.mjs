import { shared } from './guard-set.mjs';

shared('proxy', { group: 'rest', except: ['lagging'] });
