import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const shapes = `export type Circle = { kind: 'circle'; r: number };
export type Shape = Circle | { kind: 'square'; side: number };
declare const PI_OVERRIDE: number | undefined;
export function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.r ** 2;
    default:
      return (shape as { side: number }).side ** 2;
  }
}
`;

const files = {
  'node_modules/ts-demo/package.json': JSON.stringify({
    type: 'module',
    exports: { '.': './src/index.ts' },
  }),
  'node_modules/ts-demo/src/shapes.ts': shapes,
  'node_modules/ts-demo/src/index.ts': `import type { Shape } from './shapes.js';
import { area, type Circle } from './shapes.js';
export interface Named { name: string }
export type Pair<T> = [T, T];
export function describe<T extends Named>(item: T, shape?: Shape): string {
  const value: number = shape ? area(shape) : 0;
  return \`\${item.name}:\${value.toFixed(1)}\`;
}
export abstract class Base implements Named {
  public abstract name: string;
  private readonly id!: number;
  protected count?: number = 0;
  declare extra: string;
  static make<U>(this: void, value: U): U {
    return value;
  }
}
export class Thing extends Base {
  override name = 'thing';
}
export const pair = <T,>(a: T, b: T): Pair<T> => [a, b];
export const circle = { kind: 'circle', r: 1 } as const satisfies Circle;
export const first = (list: number[]) => list[0]!;
`,
  'os/ts-local.ts': `export function twice(value: number): number {
  return value * 2;
}
`,
  'os/ts-legacy.cts': `const base: number = 20;
module.exports = { value: base + 1 };
`,
  'os/ts-probe.mts': `import { describe, pair, circle, first, Thing, Base } from 'ts-demo';
import { twice } from './ts-local.js';
import legacy from './ts-legacy.cjs';
export const result = {
  described: describe({ name: 'square' }, { kind: 'square', side: 3 }),
  pair: pair<number>(1, 2),
  circle: circle.r,
  first: first([7]),
  thing: new Thing().name,
  only: (await import('ts-only')).only,
  made: Base.make('made'),
  twice: twice(21),
  legacy: legacy.value,
};
`,
  'os/ts-worker.ts': `import { describe } from 'ts-demo';
const message: string = describe({ name: 'worker' }, { kind: 'circle', r: 1 });
postMessage(message);
`,
  'os/ts-broken.ts': `export const ok: number = 1;
export enum Color { Red }
`,
  'os/ts-uses-broken.ts': `import { Color, ok } from './ts-broken.js';
export const red: number = Color.Red + ok;
`,
  'node_modules/ts-only/package.json': JSON.stringify({ exports: './index.js' }),
  'node_modules/ts-only/index.ts': `export const only: string = 'ts-only';
`,
};

async function write(page, entries) {
  await page.evaluate(async (entries) => {
    const root = await navigator.storage.getDirectory();
    for (const [path, text] of Object.entries(entries)) {
      const parts = path.split('/');
      const name = parts.pop();
      let dir = root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    }
  }, entries);
}

test('TypeScript from node_modules and OPFS loads in a page and in a worker', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await write(page, files);
  const result = await page.evaluate(async () => {
    const { result } = await import('/os/ts-probe.mts');
    const worker = new Worker('/os/ts-worker.ts', { type: 'module' });
    const fromWorker = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message || 'the worker failed'));
    });
    worker.terminate();
    const served = await fetch('/node_modules/ts-demo/src/shapes.ts');
    return {
      result,
      fromWorker,
      type: served.headers.get('content-type'),
      shapes: await served.text(),
    };
  });
  assert.deepEqual(result.result, {
    described: 'square:9.0',
    pair: [1, 2],
    circle: 1,
    first: 7,
    thing: 'thing',
    only: 'ts-only',
    made: 'made',
    twice: 42,
    legacy: 21,
  });
  assert.equal(result.fromWorker, 'worker:3.1');
  assert.equal(result.type, 'text/javascript; charset=utf-8');
  assert.equal(result.shapes.length, shapes.length);
  assert.deepEqual(result.shapes.split('\n').length, shapes.split('\n').length);
  assert.match(result.shapes, /^export function area\(shape {7}\) {9}\{$/m);
  assert.doesNotMatch(result.shapes, /type|declare|Circle|number/);
  assert.deepEqual(page.errors, []);
});

test('TypeScript that cannot be stripped fails the import with its file and line', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await write(page, files);
  const messages = await page.evaluate(() =>
    Promise.all(
      ['/os/ts-broken.ts', '/os/ts-uses-broken.ts'].map((path) =>
        import(path).then(
          () => 'loaded',
          (error) => `${error.name}: ${error.message}`
        )
      )
    )
  );
  const wanted =
    'SyntaxError: /os/ts-broken.ts:2:8: A TypeScript enum is not supported by type stripping';
  assert.deepEqual(messages, [wanted, wanted]);
  assert.deepEqual(page.errors, []);
});

const published = [
  {
    name: '@juicesharp/rpiv-todo',
    url: 'https://registry.npmjs.org/@juicesharp/rpiv-todo/-/rpiv-todo-2.12.0.tgz',
    integrity:
      'sha512-bTILerGqMGrWMUkahHzXTuYa4iPkRX/LTl12HPppcCdPg7pGwrC1K7/ZtPfp7Xi4cXzqEoyZpeUM6IA8y5gtEQ==',
  },
  {
    name: 'pi-provider-litellm',
    url: 'https://registry.npmjs.org/pi-provider-litellm/-/pi-provider-litellm-4.1.0.tgz',
    integrity:
      'sha512-bR35axdR3lIdGUIbqnVKGCVTvg/rAngMCrD4oa8GWSZ96ysHMjymeXJgQKHkpWtsh/EecA3y6JNq6ZrT21IUuA==',
  },
  {
    name: '@narumitw/pi-plan-mode',
    url: 'https://registry.npmjs.org/@narumitw/pi-plan-mode/-/pi-plan-mode-0.59.2.tgz',
    integrity:
      'sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==',
  },
];

test('real files of the three test-matrix pi extensions load as published', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const result = await page.evaluate(async (published) => {
    const { unpackTar } = await import(
      'https://cdn.jsdelivr.net/npm/modern-tar@0.8.5/dist/web/index.js'
    );
    const root = await navigator.storage.getDirectory();
    for (const { name, url, integrity } of published) {
      const bytes = await (await fetch(url)).arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
      if (`sha512-${btoa(String.fromCharCode(...digest))}` !== integrity) {
        throw new Error(`integrity mismatch for ${url}`);
      }
      const gzip = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const tar = new Uint8Array(await new Response(gzip).arrayBuffer());
      for (const { header, data } of await unpackTar(tar, { strip: 1 })) {
        if (header.type !== 'file' || !data) continue;
        const parts = ['node_modules', ...name.split('/'), ...header.name.split('/')];
        const file = parts.pop();
        let dir = root;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (await dir.getFileHandle(file, { create: true })).createWritable();
        await writable.write(data);
        await writable.close();
      }
    }
    const todo = await import('/node_modules/@juicesharp/rpiv-todo/state/state-reducer.ts');
    const litellm = await import('/node_modules/pi-provider-litellm/src/model-groups.ts');
    const plan = await import('/node_modules/@narumitw/pi-plan-mode/src/tool-selection.ts');
    const created = todo.applyTaskMutation({ tasks: [], nextId: 1 }, 'create', {
      subject: 'Strip types',
    });
    return {
      todo: [created.op.kind, created.state.tasks[0].subject, created.state.nextId],
      litellm: [litellm.stableJson({ b: 1, a: [2] }), litellm.wireString('x')],
      plan: plan.unique(['read', 'bash', 'read']),
    };
  }, published);
  assert.deepEqual(result, {
    todo: ['create', 'Strip types', 2],
    litellm: ['{"a":[2],"b":1}', 'x'],
    plan: ['read', 'bash'],
  });
  assert.deepEqual(page.errors, []);
});
