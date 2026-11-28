import { enter } from './entry.js';

await enter(() => import('./callback.js'), {
  forget: () => {
    delete globalThis.sliccCallback;
  },
});
