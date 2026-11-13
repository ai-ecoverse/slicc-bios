import { createBrowser, pageClient } from '../../../src/seed/browser.js';
import { extensionConnection } from '../../../src/seed/cdp.js';

export function iconSnapshot({
  url = 'https://ordinary.invalid/page',
  links = [],
  childLinks = [],
} = {}) {
  const strings = [];
  const string = (value) => {
    let at = strings.indexOf(value);
    if (at < 0) at = strings.push(value) - 1;
    return at;
  };
  const document = (url, links) => {
    const nodes = { nodeName: [string('#document')], attributes: [[]], parentIndex: [-1] };
    for (const link of links) {
      let parent = 0;
      if (link.fragment) {
        parent = nodes.nodeName.length;
        nodes.nodeName.push(string('#document-fragment'));
        nodes.attributes.push([]);
        nodes.parentIndex.push(0);
      }
      if (link.shadow) {
        parent = nodes.nodeName.length;
        nodes.nodeName.push(string('DIV'));
        nodes.attributes.push([]);
        nodes.parentIndex.push(0);
      }
      const index = nodes.nodeName.length;
      nodes.nodeName.push(string(link.name ?? 'LINK'));
      nodes.attributes.push(
        Object.entries(link.attributes ?? {}).flatMap(([key, value]) => [
          string(key),
          string(value),
        ])
      );
      nodes.parentIndex.push(parent);
      if (link.shadow) {
        nodes.shadowRootType ??= { index: [], value: [] };
        nodes.shadowRootType.index.push(index);
        nodes.shadowRootType.value.push(string('open'));
      }
    }
    return { documentURL: string(url), nodes };
  };
  const root = document(url, links);
  const child = document('https://protected.invalid/child', childLinks);
  return { strings, documents: [root, child] };
}

export function sharedIconBrowser(
  t,
  snapshot = iconSnapshot(),
  { tabURL, captureScreenshot } = {}
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5000 });
  const calls = [];
  const nodes = new Map();
  let nextNode = 0,
    nextSession = 0;
  const privateRead = Promise.withResolvers();
  const url = tabURL ?? 'https://ordinary.invalid/page';
  const api = {
    on() {
      return () => {};
    },
    async send(method, params = {}, session) {
      calls.push({ method, params, session });
      if (method === 'Target.getTargets')
        return { targetInfos: [{ targetId: 'tab', type: 'page', title: 'ordinary', url }] };
      if (method === 'Target.attachToTarget') return { sessionId: `virtual-${++nextSession}` };
      if (method === 'Page.getLayoutMetrics')
        return { cssVisualViewport: { clientWidth: 100, clientHeight: 100 } };
      if (method === 'Page.captureScreenshot') {
        if (typeof captureScreenshot === 'function') return captureScreenshot({ params, session });
        return { data: 'fake-not-decoded' };
      }
      if (method === 'DOM.getDocument') {
        nodes.clear();
        const nodeId = ++nextNode;
        nodes.set(nodeId, 'document');
        if (params.depth === 0) privateRead.resolve({ method, session });
        return { root: { nodeId, documentURL: url } };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        privateRead.resolve({ method, session });
        return snapshot;
      }
      if (method === 'DOM.querySelectorAll') {
        if (!nodes.has(params.nodeId))
          throw new Error(
            JSON.stringify({ code: -32000, message: 'Could not find node with given id' })
          );
        return { nodeIds: [] };
      }
      return {};
    },
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sliccExtension');
  Object.defineProperty(globalThis, 'sliccExtension', {
    configurable: true,
    value: Object.freeze({ version: '7.12.0', cdp: api }),
  });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'sliccExtension', saved);
    else delete globalThis.sliccExtension;
  });
  const browser = createBrowser({}, { storage: null, own: 'https://protected.invalid' });
  const clients = [];
  function client() {
    const connection = browser.observe(extensionConnection(api));
    clients.push(connection);
    return { connection, call: pageClient(async () => connection, globalThis).call };
  }
  t.after(() => {
    for (const connection of clients) connection.close();
  });
  return { browser, calls, client, privateRead: privateRead.promise };
}
