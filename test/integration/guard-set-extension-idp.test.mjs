import { shared } from './guard-set.mjs';

shared('extension', { group: 'idp', except: ['lagging'] });
