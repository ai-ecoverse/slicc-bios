export const VERSION = 1;
export const SWITCHBOARD_LOCK = 'slicc-switchboard';
export const TAB_LOCK = 'slicc-tab:';
export const PING_MS = 1000;
export const STALL_MS = 5000;

export function createSwitchboard({
  locks = navigator.locks,
  every = setInterval,
  now = Date.now,
  ping = PING_MS,
  stall = STALL_MS,
} = {}) {
  const tabs = new Map();
  let owner = null;
  let pinged = 0;
  let answered = now();
  let stalled = false;

  const send = (port, frame, transfer = []) => port.postMessage({ v: VERSION, ...frame }, transfer);
  const broadcast = (frame) => {
    for (const tab of tabs.values()) send(tab.port, frame);
  };
  const ownerFrame = () => ({ tab: owner, versions: owner ? tabs.get(owner).versions : null });

  function unstall() {
    if (!stalled) return;
    stalled = false;
    broadcast({ unstalled: true });
  }

  function drop(id) {
    tabs.delete(id);
    if (owner !== id) return;
    owner = null;
    unstall();
    broadcast({ owner: ownerFrame() });
  }

  function own(id, versions) {
    const tab = tabs.get(id);
    tab.versions = versions;
    const previous = owner;
    owner = id;
    answered = now();
    unstall();
    if (previous && previous !== id) send(tabs.get(previous).port, { replaced: true });
    broadcast({ owner: ownerFrame() });
  }

  function hello(port, { tab, visible, versions }) {
    if (typeof tab !== 'string' || !tab || tabs.has(tab)) {
      send(port, { refused: 'tab' });
      return null;
    }
    tabs.set(tab, { port, visible: Boolean(visible), versions: versions ?? null });
    void locks.request(`${TAB_LOCK}${tab}`, () => drop(tab));
    send(port, { welcome: { owner: ownerFrame() } });
    return tab;
  }

  function want(port, from, { id }) {
    if (owner) send(tabs.get(owner).port, { want: { id, from } });
    else send(port, { give: { id, error: 'no tab runs SLICC' } });
  }

  function give({ id, to, error, names }, ports) {
    const target = tabs.get(to);
    if (!target) {
      for (const port of ports) port.close?.();
      return;
    }
    send(target.port, { give: error ? { id, error } : { id, names } }, ports);
  }

  function pong() {
    answered = now();
    unstall();
  }

  function receive(port, data, ports, from) {
    if (data?.v !== VERSION) {
      send(port, { refused: 'version', want: VERSION });
      return from;
    }
    if (data.hello) return hello(port, data.hello) ?? from;
    const tab = tabs.get(from);
    if (!tab) return from;
    const owning = from === owner;
    if ('visible' in data) tab.visible = Boolean(data.visible);
    else if (data.own) own(from, data.own.versions ?? null);
    else if (data.want) want(port, from, data.want);
    else if (data.give && owning) give(data.give, ports);
    else if ('pong' in data && owning) pong();
    return from;
  }

  every(() => {
    if (!owner) return;
    if (!stalled && now() - answered >= stall) {
      stalled = true;
      broadcast({ stalled: { since: answered } });
    }
    pinged += 1;
    send(tabs.get(owner).port, { ping: pinged });
  }, ping);

  return {
    connect(port) {
      let from = null;
      port.addEventListener('message', ({ data, ports }) => {
        from = receive(port, data, ports, from);
      });
      port.start();
    },
    state: () => ({
      owner,
      stalled,
      tabs: [...tabs].map(([id, { visible }]) => ({ id, visible })),
    }),
  };
}

export function serve(scope, options) {
  const locks = options?.locks ?? scope.navigator.locks;
  const switchboard = createSwitchboard({ ...options, locks });
  const held = new Promise((resolve) => {
    void locks.request(SWITCHBOARD_LOCK, () => {
      resolve();
      return new Promise(() => {});
    });
  });
  scope.addEventListener('connect', ({ ports: [port] }) => {
    void held.then(() => switchboard.connect(port));
  });
  return switchboard;
}
