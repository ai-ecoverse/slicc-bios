import { osClient, skew } from './tabs.js';

export function mirrorUpdates(os) {
  const listeners = { items: new Set(), packages: new Set() };
  let items = [];
  let packages = [];
  let ready = false;
  const take = (snapshot) => {
    items = snapshot.items;
    ready = snapshot.ready;
    for (const listener of [...listeners.items]) listener(items);
  };
  const listed = (list) => {
    packages = list;
    for (const listener of [...listeners.packages]) listener(packages);
  };
  os.on('updates', take);
  os.on('packages', listed);
  void os.call('updates').then(
    (snapshot) => {
      take(snapshot);
      listed(snapshot.packages);
    },
    () => undefined
  );
  return {
    on(type, listener) {
      if (!Object.hasOwn(listeners, type)) return () => undefined;
      listeners[type].add(listener);
      return () => listeners[type].delete(listener);
    },
    list: () => items,
    packages: () => packages,
    ready: () => ready,
    get: (id) => items.find((item) => item.id === id),
    act: (id, action) => os.call('act', id, action),
    actPackage: (id, action) => os.call('actPackage', id, action),
  };
}

export function serveUpdates(updates) {
  return {
    handlers: {
      updates: () => ({
        items: updates.list(),
        ready: updates.ready(),
        packages: updates.packages(),
      }),
      act: (id, action) => updates.act(id, action),
      actPackage: (id, action) => updates.actPackage(id, action),
    },
    forward(os) {
      updates.on('packages', (list) => os.emit('packages', list));
      return updates.on('items', (items) => os.emit('updates', { items, ready: updates.ready() }));
    },
  };
}

const NETWORK = ['setTailnet', 'setExitNode', 'submitAuthKey', 'logoutTailnet', 'check'];

export function serveNetwork(port) {
  return {
    handlers: {
      network: () => port.status(),
      networkCall: (method, ...args) => {
        if (!NETWORK.includes(method) || typeof port[method] !== 'function')
          throw new Error(`the network port has no ${method}`);
        return port[method](...args);
      },
    },
    forward: (os) => port.on('network', (status) => os.emit('network', status)),
  };
}

export function mirrorNetwork(os, local) {
  const listeners = new Set();
  let current = local.status();
  const take = (status) => {
    current = status;
    for (const listener of [...listeners]) listener(current);
  };
  os.on('network', take);
  void os.call('network').then(take, () => undefined);
  const mirror = {
    on(type, listener) {
      if (type !== 'network') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => current,
  };
  for (const method of NETWORK.filter((name) => typeof local[name] === 'function')) {
    mirror[method] = (...args) => os.call('networkCall', method, ...args);
  }
  return mirror;
}

export async function biosHash(read) {
  const texts = await Promise.all(['os.js', 'tabs.js', 'present.js', 'switchboard.js'].map(read));
  const bytes = new TextEncoder().encode(texts.join('\0'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function present({
  app,
  board,
  tabs,
  base,
  versions,
  chat,
  storage,
  login,
  disk,
  wrap = (agent) => agent,
}) {
  const listeners = new Set();
  let generation = 0;
  let connection = null;
  let os = null;
  let seen = null;

  async function skewOf(theirs) {
    if (theirs?.bios && versions.bios && theirs.bios !== versions.bios) {
      return (await disk()) === versions.bios ? 'older' : 'newer';
    }
    return skew({ agent: versions.agent }, { agent: theirs?.agent });
  }

  function drop() {
    os?.close();
    os = null;
    const previous = connection;
    connection = null;
    void previous?.close().catch(() => undefined);
  }

  async function join(owner, owning, mine) {
    const loaded = owner.versions?.agent ? await chat().catch(() => null) : null;
    if (mine !== generation) return null;
    const wanted = [...(loaded ? ['agent'] : []), ...(owning ? [] : ['os'])];
    const ports = await board.ports(wanted);
    if (mine !== generation) {
      ports.agent?.close?.();
      ports.os?.close?.();
      return null;
    }
    drop();
    os = ports.os ? osClient(ports.os) : null;
    let model = { ...base(os), tabs };
    if (ports.agent) {
      const joined = await loaded.connectAgent(ports.agent);
      if (mine !== generation) {
        void joined.close().catch(() => undefined);
        return null;
      }
      connection = joined;
      const created = loaded.createAgentModel(joined, { storage, login });
      model = { ...model, ...created, agent: wrap(created.agent) };
    }
    return { model, agent: Boolean(ports.agent) };
  }

  async function attach(owner) {
    const key = JSON.stringify(owner);
    if (key === seen) return;
    seen = key;
    generation += 1;
    const mine = generation;
    if (!owner?.tab) {
      tabs.set({ role: 'connecting', stalled: false });
      return;
    }
    const owning = owner.tab === board.id;
    const skewed = owning ? null : await skewOf(owner.versions);
    if (mine !== generation) return;
    tabs.set({ skew: skewed });
    if (skewed) {
      drop();
      tabs.set({ role: 'follower' });
      return;
    }
    const joined = await join(owner, owning, mine);
    if (!joined) return;
    app.model = joined.model;
    tabs.set({ role: owning ? 'owner' : 'follower' });
    for (const listener of [...listeners]) listener(joined.agent);
  }

  function settle(owner) {
    return attach(owner).catch((error) => {
      console.warn(`this tab did not attach to the tab running SLICC: ${error.message}`);
      for (const listener of [...listeners]) listener(false);
    });
  }

  board.on('owner', (owner) => void settle(owner));
  board.on('stalled', () => {
    if (board.owner()?.tab !== board.id) tabs.set({ stalled: true });
  });
  board.on('unstalled', () => tabs.set({ stalled: false }));

  return {
    attach: () => settle(board.owner()),
    next() {
      return new Promise((resolve) => {
        const done = (agent) => {
          listeners.delete(done);
          resolve(agent);
        };
        listeners.add(done);
      });
    },
    connection: () => connection,
  };
}
