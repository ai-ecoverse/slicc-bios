const steps = [
  {
    id: 'opfs',
    verb: 'Opening private storage',
    fail: 'Couldn’t open private storage',
    weight: 0.05,
  },
  {
    id: 'installer',
    verb: 'Starting the installer',
    fail: 'Couldn’t start the installer',
    weight: 0.04,
  },
  { id: 'packages', verb: 'Installing packages', fail: 'Couldn’t install packages', weight: 0.63 },
  { id: 'seed', verb: 'Placing the interface', fail: 'Couldn’t place the interface', weight: 0.12 },
  { id: 'intercept', verb: 'Sealing the sandbox', fail: 'Couldn’t seal the sandbox', weight: 0.1 },
  { id: 'navigate', verb: 'Starting seven', fail: 'Couldn’t start seven', weight: 0.06 },
];

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
    body: 'Servers in <code>~/.pi/agent/mcp.json</code> show up under Settings › MCP servers, with <strong>Connect</strong> or <strong>Sign in</strong>.',
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
const card = find('.splash');
const verb = find('.verb', card);
const detail = find('.detail', card);
const credits = find('.credits', card);
const drawer = find('.diagnostics', card);
const toggle = find('.details', card);
const log = find('.log', drawer);
const env = find('.env', drawer);
const retries = [...card.querySelectorAll('.retry')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const repeat = Boolean(navigator.serviceWorker?.controller);
const origin = performance.now();
const entries = [];
const model = Object.fromEntries(
  steps.map(({ id }) => [id, { state: 'pending', fraction: null, started: 0 }])
);
let failed = false;
let ready = false;
let last = origin;

function progress(now = performance.now()) {
  let sum = 0;
  for (const { id, weight } of steps) {
    const { state, fraction, started } = model[id];
    if (state === 'done') sum += weight;
    else if (state === 'active' || state === 'failed')
      sum += weight * (fraction ?? 0.85 * (1 - Math.exp(-(now - started) / 1400)));
  }
  return ready ? 1 : Math.min(1, sum);
}

function redact(text) {
  return String(text)
    .replace(/\b([a-z][\w+.-]*:\/\/[^\s/?#]+[^\s?#]*)[?#]\S*/gi, '$1')
    .replace(/(^|[\s"'(=])(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s]+/g, '$1~')
    .replace(/\b(token|key|secret|password|auth|code|sig|seat|join)=\S+/gi, '$1=…')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[a-z])[-_][\w-]{12,}/g, '…')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '…');
}

function seconds(at) {
  return `${((at - origin) / 1000).toFixed(2)}s`;
}

function write(level, tag, text) {
  const now = performance.now();
  const entry = {
    at: seconds(now),
    level,
    tag,
    text: redact(text),
    ms: `${Math.round(now - last)}ms`,
  };
  last = now;
  entries.push(entry);
  const item = document.createElement('li');
  item.dataset.level = level;
  const time = document.createElement('time');
  time.textContent = entry.at;
  const cells = [entry.tag, entry.text, entry.ms].map((value) => {
    const cell = document.createElement('span');
    cell.textContent = value;
    return cell;
  });
  item.append(time, ...cells);
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.append(item);
  if (stick) log.scrollTop = log.scrollHeight;
}

function segment(id) {
  return card.querySelector(`[data-segment="${id}"]`);
}

function open(wanted = !drawer.classList.contains('open')) {
  drawer.classList.toggle('open', wanted);
  drawer.inert = !wanted;
  toggle.setAttribute('aria-expanded', String(wanted));
}

function row(key, value) {
  const term = document.createElement('dt');
  term.textContent = key;
  const description = document.createElement('dd');
  description.dataset.key = key;
  description.textContent = value;
  env.append(term, description);
}

function set(key, value) {
  const description = env.querySelector(`[data-key="${key}"]`);
  if (description) description.textContent = value;
}

function browser() {
  const brand = navigator.userAgentData?.brands?.find(({ brand }) =>
    /Chrom|Edge|Brave|Opera/.test(brand)
  );
  return brand ? `${brand.brand} ${brand.version}` : navigator.userAgent.split(') ').pop();
}

function story() {
  const slide = find('.slide', card);
  const dots = find('.dots', card);
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

async function thanks() {
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
    if (model.packages.state === 'done') item.className = 'done';
    credits.append(item, at < names.length - 1 ? ', ' : '');
  }
  credits.append(', and the people who make them.');
}

async function scene() {
  if (reduced.matches) return set('render', 'static artwork, reduced motion');
  const { start } = await import('./scene.js');
  const result = await start({
    canvas: find('.scene', card),
    ambient: find('.ambient'),
    card,
    progress,
    failed: () => failed,
    ready: () => ready,
    reduced,
    running: (gpu) => {
      card.dataset.scene = 'running';
      set('gpu', gpu);
    },
    stats: (text) => set('render', text),
  });
  if (result) {
    card.dataset.scene = 'static';
    set('render', `static artwork, ${result}`);
    write('warn', 'scene', `static artwork: ${result}`);
  }
}

async function copy(event) {
  const button = event.currentTarget;
  const lines = [
    'SLICC seven boot diagnostics',
    ...[...env.querySelectorAll('dt')].map(
      (term) => `${term.textContent}: ${term.nextElementSibling.textContent}`
    ),
    '',
    ...steps.map(
      ({ id }) => `${model[id].state.padEnd(8)} ${id}: ${find(`[data-step="${id}"] output`).value}`
    ),
    '',
    ...entries.map(
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
}

function attach() {
  row('browser', browser());
  row('origin', location.origin);
  row('isolated', String(globalThis.crossOriginIsolated));
  row('cores', String(navigator.hardwareConcurrency ?? '?'));
  row('gpu', '…');
  row('storage', '…');
  row('render', 'static artwork');
  write('info', 'bios', `boot (${repeat ? 'repeat visit' : 'first install'})`);
  toggle.addEventListener('click', () => open());
  find('.close', drawer).addEventListener('click', () => open(false));
  find('.copy', drawer).addEventListener('click', copy);
  for (const button of retries) button.addEventListener('click', () => location.reload());
  const turn = story();
  addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'd' || event.key === 'D') open();
    else if (event.key === 'Escape') open(false);
    else if (event.key === 'ArrowRight') turn(1);
    else if (event.key === 'ArrowLeft') turn(-1);
  });
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
  thanks().catch(() => {
    credits.textContent = '© ai-ecoverse. SLICC seven, built in the open.';
  });
  requestAnimationFrame(() =>
    requestIdleCallback(
      () =>
        setTimeout(
          () => scene().catch((error) => set('render', `static artwork, ${error.message}`)),
          repeat ? 1500 : 0
        ),
      { timeout: 300 }
    )
  );
}

export const splash = {
  begin(id) {
    const step = steps.find((item) => item.id === id);
    Object.assign(model[id], { state: 'active', fraction: null, started: performance.now() });
    segment(id).dataset.state = 'active';
    verb.textContent = step.verb;
    detail.textContent = '';
    write('info', id, 'started');
  },
  report(id, text, counted) {
    if (counted?.total) {
      model[id].fraction = counted.done / counted.total;
      segment(id).style.setProperty('--fill', model[id].fraction.toFixed(4));
    }
    detail.textContent = text;
    write('info', id, text);
    const lit =
      counted && credits.querySelector(`[data-package="${CSS.escape(text.split(' ').pop())}"]`);
    if (lit) lit.className = 'done';
  },
  done(id, text) {
    model[id].state = 'done';
    segment(id).dataset.state = 'done';
    detail.textContent = text;
    write('ok', id, text);
    if (id === 'packages')
      for (const item of credits.querySelectorAll('span')) item.className = 'done';
    if (id === 'navigate') {
      ready = true;
      card.dataset.state = 'ready';
      verb.textContent = 'Ready';
    }
  },
  fail(id, message) {
    model[id].state = 'failed';
    failed = true;
    segment(id).dataset.state = 'failed';
    card.dataset.state = 'failed';
    verb.textContent = steps.find((item) => item.id === id).fail;
    detail.textContent = message;
    for (const button of retries) button.hidden = false;
    write('error', id, message);
    open(true);
  },
};

attach();
