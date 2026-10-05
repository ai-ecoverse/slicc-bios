export const steps = ['opfs', 'installer', 'packages', 'seed', 'intercept', 'navigate'];
export const booted = steps.flatMap((step) => [`${step}:active`, `${step}:done`]);

export async function watch(page) {
  const events = [];
  await page.expose('bios', (event) => events.push(event));
  await page.init(() => {
    const observer = new MutationObserver((records) => {
      for (const { type, target } of records) {
        if (type === 'attributes' || target.localName === 'output') {
          const item = target.closest('[data-step]');
          if (!item) continue;
          const { step, state } = item.dataset;
          const text = item.querySelector('output').value;
          window.bios(JSON.stringify({ type, step, state, text }));
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributeFilter: ['data-state'] });
    addEventListener('pagereveal', ({ viewTransition }) => {
      const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
      const optIn = rules.some((rule) => rule.navigation === 'auto');
      const transition = Boolean(viewTransition);
      window.bios(JSON.stringify({ type: 'reveal', path: location.pathname, optIn, transition }));
    });
  });
  return {
    states: () => events.filter((e) => e.type === 'attributes').map((e) => `${e.step}:${e.state}`),
    texts: (step) =>
      events.filter((e) => e.type === 'childList' && e.step === step).map((e) => e.text),
    reveals: () =>
      events.filter((e) => e.type === 'reveal').map((e) => `${e.path}:${e.optIn}:${e.transition}`),
  };
}

export async function boot(page) {
  await page.goto('/');
  await ready(page);
}

export const prompt = 'slicc:~$ ';

export async function ready(page) {
  await page.until(
    (prompt) =>
      location.pathname === '/os/' &&
      document.querySelector('slicc-terminal .term-grid')?.textContent.includes(prompt),
    prompt
  );
}

export async function shows(page, text) {
  await page.until(
    (needle) => document.querySelector('slicc-terminal .term-grid').textContent.includes(needle),
    text
  );
}

export async function run(page, command) {
  await page.evaluate(() => document.querySelector('slicc-terminal').focus());
  await page.insert(command);
  await page.enter();
}

export async function opfs(page) {
  return page.evaluate(async () => {
    const paths = [];
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`);
        else paths.push(`${prefix}${name}`);
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return paths.sort();
  });
}

export async function eventually(check) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
