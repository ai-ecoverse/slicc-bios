import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { forgetHandOffs } from './handoff.js';
import * as rule from './seven-rule.js';

export const sevenHost = (at) => rule.sevenHost(catalog.seven, at);

export const refusesBoot = (at) => rule.refusesBoot(catalog.seven, at);

export const notSevenText = (origin) =>
  `Seven runs only on its own https sliccy.ai addresses, and ${origin} isn’t one of them, so seven doesn’t start here.`;

export function notSeven(doc, origin, { forget = forgetHandOffs } = {}) {
  forget();
  const box = doc.createElement('main');
  box.dataset.refused = 'not-seven';
  const title = doc.createElement('h1');
  title.textContent = 'Seven doesn’t run here';
  const text = doc.createElement('p');
  text.textContent = notSevenText(origin);
  box.append(title, text);
  doc.body.replaceChildren(box);
  return box;
}
