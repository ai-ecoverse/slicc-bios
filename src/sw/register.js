export const AFRESH = 'afresh';

export async function intercept(container, script, scope) {
  const options = { type: 'module', scope };
  const plain = new URL(script);
  plain.search = '';
  const fresh = new URL(plain);
  fresh.search = AFRESH;
  const known = await container.getRegistration(scope);
  const newest = known && (known.installing ?? known.waiting ?? known.active);
  const current = newest?.scriptURL === fresh.href ? fresh : plain;
  const registration = await container.register(current, options);
  if (registration.installing || registration.waiting) return registration;
  try {
    await registration.update();
    return registration;
  } catch (error) {
    const next = current === fresh ? plain : fresh;
    console.warn(`bios: ${current.href} didn't update (${error.message}), installing ${next.href}`);
    return container.register(next, options).catch(() => {
      throw error;
    });
  }
}
