import { readFileSync, writeFileSync } from 'node:fs';

const file = 'node_modules/@ai-ecoverse/slicc-browsers/extension-world.mjs';
let s = readFileSync(file, 'utf8');
const setupEnd = "onclick=\"document.body.dataset.clicked=\\'yes\\'\">C9 click</button>`',";
if (!s.includes(setupEnd)) throw new Error('setup anchor');
s = s.replace(
  setupEnd,
  "onclick=\"document.body.dataset.clicked=\\'yes\\'\">C9 click</button>`; window.c9log = []; for (const t of [\\'pointerdown\\', \\'mousedown\\', \\'pointerup\\', \\'mouseup\\', \\'click\\']) addEventListener(t, (e) => c9log.push(t + \\'@\\' + e.clientX + \\',\\' + e.clientY + \\':\\' + e.target.tagName + \\':\\' + Math.round(performance.now())), true)',"
);
const before = "  await outcome(reader.send('Page.bringToFront', {}, observer));";
if (!s.includes(before)) throw new Error('front anchor');
const state =
  'JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus(), hit: document.elementFromPoint(20, 20)?.tagName, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, t: Math.round(performance.now()), url: location.href })';
s = s.replace(
  before,
  `  const pre = await outcome(client.send('Runtime.evaluate', { expression: ${JSON.stringify(state)}, returnByValue: true }, session));\n${before}\n  const front = await outcome(client.send('Runtime.evaluate', { expression: ${JSON.stringify(state)}, returnByValue: true }, session));`
);
const ret = '  return {\n    exists: true,\n    alive: await live(),';
if (!s.includes(ret)) throw new Error('return anchor');
s = s.replace(
  ret,
  `  const after = await outcome(client.send('Runtime.evaluate', { expression: ${JSON.stringify(`JSON.stringify({ log: window.c9log, ${state.slice(16, -3)} })`)}, returnByValue: true }, session));\n  const brief = (o) => (o.ok ? (o.result?.result?.value ?? 'ok') : 'ERR ' + o.error?.message);\n  console.error('probe c9 ' + JSON.stringify({ leg: client.transport ?? 'unguarded', setup: brief(setup), pre: brief(pre), front: brief(front), down: brief(down), up: brief(up), click: brief(click), after: brief(after) }));\n${ret}`
);
writeFileSync(file, s);
console.log('patched');
