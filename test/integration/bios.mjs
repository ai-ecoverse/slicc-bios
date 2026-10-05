export const steps = ['opfs', 'kernel', 'bash', 'seed', 'script', 'intercept', 'navigate'];
export const booted = steps.flatMap((step) => [`${step}:active`, `${step}:done`]);

export async function watch(page) {
  const events = [];
  await page.expose('bios', (event) => events.push(event));
  await page.init(() => {
    const observer = new MutationObserver((records) => {
      for (const { type, target } of records) {
        if (type === 'attributes' || target.localName === 'output') {
          const item = target.closest('[data-step]');
          const { step, state } = item.dataset;
          const text = item.querySelector('output').value;
          window.bios(JSON.stringify({ type, step, state, text }));
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributeFilter: ['data-state'] });
    addEventListener('pagereveal', () => {
      const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
      const optIn = rules.some((rule) => rule.navigation === 'auto');
      window.bios(JSON.stringify({ type: 'reveal', path: location.pathname, optIn }));
    });
  });
  return {
    states: () => events.filter((e) => e.type === 'attributes').map((e) => `${e.step}:${e.state}`),
    texts: (step) =>
      events.filter((e) => e.type === 'childList' && e.step === step).map((e) => e.text),
    reveals: () => events.filter((e) => e.type === 'reveal').map((e) => `${e.path}:${e.optIn}`),
  };
}

export async function boot(page) {
  await page.goto('/');
  await landed(page);
}

export async function landed(page) {
  await page.until(
    () =>
      location.pathname === '/os/bash.html' &&
      /^Hello from bash 5\.3\.\d+\(1\)-release$/.test(
        document.getElementById('shell')?.textContent
      ) &&
      /^Connected to the kernel \(connection \d+\)$/.test(
        document.getElementById('kernel')?.textContent
      )
  );
}

export async function ui(page) {
  await page.goto('/os/');
  await page.until(
    () =>
      location.pathname === '/os/' &&
      document.querySelectorAll('#files li').length === 8 &&
      /^bash\.wasm compiled from OPFS: \d+ exports$/.test(
        document.getElementById('bash').textContent
      )
  );
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
