import { shared } from './guard-set.mjs';

shared('link', { group: 'seven', except: ['lagging'] });
