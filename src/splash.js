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

const find = (selector, root = document) => root.querySelector(selector);
const card = find('.splash');
const verb = find('.verb', card);
const detail = find('.detail', card);
const drawer = find('.diagnostics', card);
const toggle = find('.details', card);
const retries = [...card.querySelectorAll('.retry')];
const origin = performance.now();
const entries = [];
const listeners = new Set();
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

function emit(event) {
  for (const listener of listeners) listener(event);
}

function write(level, tag, text) {
  const now = performance.now();
  const entry = {
    at: `${((now - origin) / 1000).toFixed(2)}s`,
    level,
    tag,
    text: String(text),
    ms: `${Math.round(now - last)}ms`,
  };
  last = now;
  entries.push(entry);
  emit({ type: 'entry', entry });
}

function segment(id) {
  return card.querySelector(`[data-segment="${id}"]`);
}

function open(wanted = !drawer.classList.contains('open')) {
  drawer.classList.toggle('open', wanted);
  drawer.inert = !wanted;
  toggle.setAttribute('aria-expanded', String(wanted));
  emit({ type: 'open', open: wanted });
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
    if (counted) emit({ type: 'package', path: text.split(' ').pop() });
  },
  done(id, text) {
    model[id].state = 'done';
    segment(id).dataset.state = 'done';
    detail.textContent = text;
    write('ok', id, text);
    emit({ type: 'done', id });
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

const boot = {
  steps,
  model,
  entries,
  card,
  drawer,
  toggle,
  progress,
  open,
  write,
  failed: () => failed,
  ready: () => ready,
  listen: (listener) => listeners.add(listener),
};

for (const button of retries) button.addEventListener('click', () => location.reload());
write(
  'info',
  'bios',
  `boot (${navigator.serviceWorker?.controller ? 'repeat visit' : 'first install'})`
);
requestAnimationFrame(() =>
  setTimeout(() => import('./card.js').then(({ attach }) => attach(boot)))
);
