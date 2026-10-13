import { writeFile } from 'node:fs/promises';

const reveal = (selector) => {
  const deep = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && deep(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  deep(document)?.scrollIntoView({ block: 'start' });
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function shoot(page, name, { show, target, before } = {}) {
  const app = (fn, arg) =>
    page.evaluate(
      new Function('arg', `return (${fn})(document.querySelector('slicc-app'), arg)`),
      arg
    );
  const capture = async (file, clip) => {
    await pause(800);
    if (before) await page.evaluate(before);
    if (target)
      await page.evaluate(new Function('selector', `return (${reveal})(selector)`), target);
    await pause(before ? 800 : 300);
    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {}),
    });
    await writeFile(new URL(file, page.dir), Buffer.from(data, 'base64'));
  };
  const theme = (wanted) =>
    app((el, wanted) => {
      if (el.color !== wanted) el.toggleColor();
    }, wanted);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  if (show) await app((el, id) => el.show(id), show);
  for (const color of ['light', 'dark']) {
    await theme(color);
    await capture(`${name}-${color}-1280.png`);
  }
  await theme('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  if (show) await app((el, id) => el.show(id), show);
  await capture(`${name}-light-420.png`, { x: 0, y: 0, width: 420, height: 800, scale: 1 });
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
}
