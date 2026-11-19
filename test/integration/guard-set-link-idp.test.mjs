import { shared } from './guard-set.mjs';

shared('link', { group: 'idp', except: ['lagging'] });
