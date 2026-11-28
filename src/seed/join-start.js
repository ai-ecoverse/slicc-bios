import { enter, uncached } from './entry.js';

uncached();
await enter(() => import('./join.js'));
