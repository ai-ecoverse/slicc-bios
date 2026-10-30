export async function observeExtensionCommands(page) {
  await page.evaluate(async () => {
    const original = MessagePort.prototype.postMessage;
    let bridge;
    let active = false;
    let commands = 0;
    let aboutNavigations = 0;
    MessagePort.prototype.postMessage = function (data, ...args) {
      const command = data?.cdp;
      if (!bridge && command?.method === 'Browser.getVersion') bridge = this;
      if (this === bridge && active && typeof command?.method === 'string') {
        commands += 1;
        if (
          command.method === 'Page.navigate' &&
          typeof command.params?.url === 'string' &&
          /^about:/i.test(command.params.url.trim())
        )
          aboutNavigations += 1;
      }
      return Reflect.apply(original, this, [data, ...args]);
    };
    try {
      await globalThis.sliccExtension.cdp.send('Browser.getVersion');
      if (!bridge) throw new Error('the extension backend bridge was not observed');
      active = true;
      globalThis.finishExtensionObservation = () => {
        const started = active;
        active = false;
        MessagePort.prototype.postMessage = original;
        return { bound: Boolean(bridge), started, ended: true, commands, aboutNavigations };
      };
    } catch (error) {
      MessagePort.prototype.postMessage = original;
      throw error;
    }
  });
  return () => page.evaluate(() => globalThis.finishExtensionObservation());
}
