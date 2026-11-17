const pitch = [
  {
    headline: 'An operating system that works for you.',
    body: 'Agents (we call them cones and scoops) run shells, read and write files and use the web on your behalf.',
  },
  {
    headline: 'It runs right here, in this tab.',
    body: 'No download, no server. A kernel, a shell and the packages they need are unpacking into your browser’s private storage as you read this.',
  },
  {
    headline: 'Sandboxed by default.',
    body: 'Nothing in seven can reach your computer, your tabs or your accounts. Every file it serves is checked against what it installed.',
  },
  {
    headline: 'Powerful when you say so.',
    body: 'Mount a folder, connect an account, sign in to a tool, and seven goes to work on your world. You decide what it can reach.',
  },
];

const tips = [
  {
    headline: 'Start a scoop that reports back.',
    body: '<code>agent --async …</code> runs a scoop in the background and licks its cone when it’s done.',
  },
  {
    headline: 'Hand over a folder, and only that.',
    body: 'Mount a folder from Files. The agent can work in it and nowhere else on your computer.',
  },
  {
    headline: 'Keep seven’s files.',
    body: 'Install seven as an app. Chrome then keeps your files and chats when disk space runs low.',
  },
  {
    headline: 'Bring back an old conversation.',
    body: 'The Freezer keeps every chat. <strong>Thaw</strong> turns one back into a cone.',
  },
  {
    headline: 'Switch models from the shell.',
    body: '<code>models</code> lists the models of your connected accounts and switches the one you’re talking to.',
  },
  {
    headline: 'See what agents changed.',
    body: '<code>pnpm add -g @ai-ecoverse/wasm-git</code>, then open Changes to accept or revert each edit.',
  },
  {
    headline: 'The agent’s memory is plain text.',
    body: 'Memory shows the <code>MEMORY.md</code> files the agent writes. Edit them by hand or with <strong>Forget</strong>.',
  },
  {
    headline: 'You’re root. Agents aren’t.',
    body: 'Cones and scoops run as their own users, and <code>sudo</code> asks you before they get more.',
  },
  {
    headline: 'Real HTTPS from the terminal.',
    body: '<code>curl https://…</code> works: TLS ends inside the kernel, in this tab.',
  },
  {
    headline: 'Connect an MCP server.',
    body: '<strong>Add server</strong> under Settings › MCP servers takes a name and a URL, no terminal needed. Seven saves it in <code>/etc/slicc/agent/mcp.json</code>.',
  },
  {
    headline: 'Edit and save in place.',
    body: '<strong>Edit</strong> turns a file tab into a text area; <kbd>Mod</kbd>+<kbd>S</kbd> writes it back.',
  },
  {
    headline: 'Your shell survives reloads.',
    body: 'Whatever the terminal writes stays in private storage. Open as many terminals as you like with <strong>+</strong>.',
  },
];

const find = (selector, root = document) => root.querySelector(selector);

export function redact(text) {
  return String(text)
    .replace(/\b([a-z][\w+.-]*:\/\/[^\s/?#]+[^\s?#]*)[?#]\S*/gi, '$1')
    .replace(/(^|[\s"'(=])(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s]+/g, '$1~')
    .replace(/\b(token|key|secret|password|auth|code|sig|seat|join)=\S+/gi, '$1=…')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[a-z])[-_][\w-]{12,}/g, '…')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '…');
}

function line(entry) {
  const item = document.createElement('li');
  item.dataset.level = entry.level;
  const time = document.createElement('time');
  time.textContent = entry.at;
  const cells = [entry.tag, redact(entry.text), entry.ms].map((value) => {
    const cell = document.createElement('span');
    cell.textContent = value;
    return cell;
  });
  item.append(time, ...cells);
  return item;
}

function journal(boot) {
  const log = find('.log', boot.drawer);
  let shown = 0;
  const render = () => {
    if (!boot.drawer.classList.contains('open')) return;
    const stick = shown === 0 || log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.append(...boot.entries.slice(shown).map(line));
    shown = boot.entries.length;
    if (stick) log.scrollTop = log.scrollHeight;
  };
  render();
  return render;
}

const LOOK = 5000;
const SIX_LOCKS = ['slicc-six-kernel', 'slicc-tray-leader-active'];

const path = (url) => (url ? new URL(url).pathname : 'none');

async function workers(container = navigator.serviceWorker) {
  if (!container) return 'unavailable';
  const registrations = await container.getRegistrations();
  const listed = registrations.map((registration) => {
    const worker = registration.active ?? registration.waiting ?? registration.installing;
    const state = worker ? worker.state : 'none';
    return `${new URL(registration.scope).pathname} ${path(worker?.scriptURL)} ${state}`;
  });
  return `${listed.join('; ') || 'none'}, controller ${path(container.controller?.scriptURL)}`;
}

const NOISE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function lockLine({ held = [], pending = [] }) {
  const count = (all) => {
    const list = all.filter(({ name }) => !NOISE.test(name));
    const names = new Map();
    for (const { name } of list) names.set(name, (names.get(name) ?? 0) + 1);
    return [...names].map(([name, times]) => (times > 1 ? `${name} ×${times}` : name)).join(', ');
  };
  const parts = [
    ['held', count(held)],
    ['waiting', count(pending)],
  ].filter(([, names]) => names);
  return parts.map(([what, names]) => `${what} ${names}`).join('; ') || 'none';
}

async function six(locks) {
  const root = await navigator.storage.getDirectory();
  const profile = await root.getDirectoryHandle('slicc-fs').then(
    async (dir) => !(await dir.keys().next()).done,
    () => false
  );
  const marker = localStorage.getItem('slicc-os.six');
  const retired = Boolean(await globalThis.cookieStore?.get('__Host-slicc-six-retired'));
  const tabs = (locks.held ?? []).some(({ name }) => SIX_LOCKS.includes(name));
  if (!profile && !marker && !retired && !tabs) return 'none';
  return [
    `profile ${profile ? 'yes' : 'no'}`,
    `marker ${marker ?? 'none'}`,
    `retired ${retired ? 'yes' : 'no'}`,
    `tab ${tabs ? 'open' : 'none seen'}`,
  ].join(', ');
}

async function surroundings() {
  const locks = (await navigator.locks?.query?.().catch(() => null)) ?? {};
  const settle = (promise) => promise.catch((error) => `unavailable, ${error.message}`);
  const [registered, sixth] = await Promise.all([settle(workers()), settle(six(locks))]);
  return { workers: registered, locks: lockLine(locks), six: sixth };
}

function environment(boot) {
  const env = find('.env', boot.drawer);
  const row = (key, value) => {
    const term = document.createElement('dt');
    term.textContent = key;
    const description = document.createElement('dd');
    description.dataset.key = key;
    description.textContent = value;
    env.append(term, description);
  };
  const brand = navigator.userAgentData?.brands?.find(({ brand }) =>
    /Chrom|Edge|Brave|Opera/.test(brand)
  );
  row('browser', brand ? `${brand.brand} ${brand.version}` : navigator.userAgent.split(') ').pop());
  row('origin', location.origin);
  row('isolated', String(globalThis.crossOriginIsolated));
  row('cores', String(navigator.hardwareConcurrency ?? '?'));
  row('gpu', '…');
  row('storage', '…');
  row('render', 'static artwork');
  row('workers', '…');
  row('locks', '…');
  row('six', '…');
  const set = (key, value) => {
    env.querySelector(`[data-key="${key}"]`).textContent = value;
  };
  const look = () =>
    surroundings()
      .then((found) => {
        for (const [key, value] of Object.entries(found)) set(key, value);
      })
      .catch(() => {});
  void look();
  setInterval(look, LOOK);
  set.look = look;
  navigator.storage
    ?.estimate?.()
    .then(async ({ quota, usage }) => {
      const persisted = await navigator.storage.persisted?.();
      set(
        'storage',
        `${persisted ? 'persistent' : 'best effort'}, ${(usage / 1e6).toFixed(1)}MB of ${(quota / 1e9).toFixed(1)}GB`
      );
    })
    .catch(() => set('storage', 'unavailable'));
  return set;
}

function story(repeat) {
  const slide = find('.slide');
  const dots = find('.dots');
  const items = repeat ? tips : pitch;
  let index = 0;
  let timer = 0;
  if (repeat) {
    const seen = Number(localStorage.getItem('slicc-bios.tip') ?? -1) + 1;
    localStorage.setItem('slicc-bios.tip', String(seen % tips.length));
    index = seen % tips.length;
  }
  const show = (wanted, animate = true) => {
    index = (wanted + items.length) % items.length;
    const apply = () => {
      find('.headline', slide).innerHTML = items[index].headline;
      find('.body', slide).innerHTML = items[index].body;
      slide.classList.remove('out');
      for (const [at, dot] of [...dots.children].entries())
        dot.setAttribute('aria-selected', String(at === index));
    };
    if (!animate) return apply();
    slide.classList.add('out');
    setTimeout(apply, 380);
  };
  const schedule = () => {
    clearInterval(timer);
    if (!repeat) timer = setInterval(() => show(index + 1), 5200);
  };
  for (const at of items.keys()) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.role = 'tab';
    dot.setAttribute('aria-label', `Message ${at + 1}`);
    dot.addEventListener('click', () => {
      show(at);
      schedule();
    });
    dots.append(dot);
  }
  show(index, false);
  schedule();
  return (step) => {
    show(index + step);
    schedule();
  };
}

async function thanks(boot) {
  const credits = find('.credits');
  const { dependencies } = await (await fetch('packages/package.json')).json();
  const names = Object.keys(dependencies);
  const short = (name) => name.replace(/^@ai-ecoverse\/(wasm-|wasi-|slicc-)?/, '');
  const versions = ['slicc-kernel', 'slicc-spectrum']
    .filter((name) => dependencies[`@ai-ecoverse/${name}`])
    .map((name) => ` · ${short(`@ai-ecoverse/${name}`)} ${dependencies[`@ai-ecoverse/${name}`]}`)
    .join('');
  credits.textContent = `© ai-ecoverse. SLICC seven${versions}. Built in the open on `;
  for (const [at, name] of names.entries()) {
    const item = document.createElement('span');
    item.dataset.package = `node_modules/${name}`;
    item.textContent = short(name);
    if (boot.model.packages.state === 'done') item.className = 'done';
    credits.append(item, at < names.length - 1 ? ', ' : '');
  }
  credits.append(', and the people who make them.');
  return (event) => {
    if (event.type === 'done' && event.id === 'packages')
      for (const item of credits.querySelectorAll('span')) item.className = 'done';
    if (event.type !== 'package') return;
    const lit = credits.querySelector(`[data-package="${CSS.escape(event.path)}"]`);
    if (lit) lit.className = 'done';
  };
}

async function scene(boot, set, reduced) {
  if (reduced.matches) return set('render', 'static artwork, reduced motion');
  const { start } = await import('./scene.js');
  const result = await start({
    canvas: find('.scene', boot.card),
    ambient: find('.ambient'),
    card: boot.card,
    progress: boot.progress,
    failed: boot.failed,
    ready: boot.ready,
    reduced,
    running: (gpu) => {
      boot.card.dataset.scene = 'running';
      set('gpu', gpu);
    },
    stats: (text) => set('render', text),
  });
  if (result) {
    boot.card.dataset.scene = 'static';
    set('render', `static artwork, ${result}`);
    boot.write('warn', 'scene', `static artwork: ${result}`);
  }
}

function copier(boot, set) {
  return async (event) => {
    const button = event.currentTarget;
    await set.look?.().catch(() => {});
    const lines = [
      'SLICC seven boot diagnostics',
      ...[...boot.drawer.querySelectorAll('dt')].map(
        (term) => `${term.textContent}: ${term.nextElementSibling.textContent}`
      ),
      '',
      ...boot.steps.map(
        ({ id }) =>
          `${boot.model[id].state.padEnd(8)} ${id}: ${find(`[data-step="${id}"] output`).value}`
      ),
      '',
      ...boot.entries.map(
        (entry) =>
          `[${entry.at.padStart(7)}] ${entry.level.padEnd(5)} ${entry.tag.padEnd(10)} ${entry.text} (${entry.ms})`
      ),
    ];
    try {
      await navigator.clipboard.writeText(redact(lines.join('\n')));
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.textContent = 'Copy diagnostics';
    }, 1500);
  };
}

export function attach(boot) {
  const repeat = Boolean(navigator.serviceWorker?.controller);
  const set = environment(boot);
  const render = journal(boot);
  const turn = story(repeat);
  let light = () => {};
  boot.listen((event) => {
    render();
    light(event);
  });
  boot.toggle.addEventListener('click', () => boot.open());
  find('.close', boot.drawer).addEventListener('click', () => boot.open(false));
  find('.copy', boot.drawer).addEventListener('click', copier(boot, set));
  addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'd' || event.key === 'D') boot.open();
    else if (event.key === 'Escape') boot.open(false);
    else if (event.key === 'ArrowRight') turn(1);
    else if (event.key === 'ArrowLeft') turn(-1);
  });
  thanks(boot)
    .then((update) => {
      light = update;
    })
    .catch(() => {
      find('.credits').textContent = '© ai-ecoverse. SLICC seven, built in the open.';
    });
  requestIdleCallback(
    () =>
      setTimeout(
        () =>
          scene(boot, set, matchMedia('(prefers-reduced-motion: reduce)')).catch((error) =>
            set('render', `static artwork, ${error.message}`)
          ),
        repeat ? 1500 : 0
      ),
    { timeout: 300 }
  );
}
