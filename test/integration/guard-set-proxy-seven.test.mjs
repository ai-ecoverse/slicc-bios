import { shared } from './guard-set.mjs';

shared('proxy', { group: 'seven', except: ['lagging'] });
