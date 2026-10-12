import { takeFollow } from './follow.js';

if (takeFollow()) await import('./follower.js');
else await import('./os.js');
