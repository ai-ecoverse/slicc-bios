import { shared } from './guard-set.mjs';

shared('extension', { group: 'rest', except: ['lagging'] });
