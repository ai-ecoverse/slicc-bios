export function rowDeadline(row, milliseconds = 120000) {
  const controller = new AbortController();
  row.deadline = { started: Date.now(), milliseconds };
  const timer = setTimeout(() => {
    row.deadline.expiredAt = Date.now();
    controller.abort(new Error(`whole row ${row.name} exceeded ${milliseconds}ms at ${row.step}`));
  }, milliseconds);
  const wait = async (run) => {
    if (controller.signal.aborted) throw controller.signal.reason;
    let aborted;
    try {
      return await Promise.race([
        Promise.resolve().then(run),
        new Promise((_, reject) => {
          aborted = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', aborted, { once: true });
        }),
      ]);
    } finally {
      controller.signal.removeEventListener('abort', aborted);
    }
  };
  return {
    wait,
    wrap(target, names) {
      if (!target) return target;
      return new Proxy(target, {
        get(object, key) {
          const value = Reflect.get(object, key, object);
          if (typeof value !== 'function') return value;
          return names.includes(key)
            ? (...args) => wait(() => value.apply(object, args))
            : value.bind(object);
        },
      });
    },
    end() {
      clearTimeout(timer);
      row.deadline.finishedAt = Date.now();
      if (controller.signal.aborted) {
        row.status = 'finding';
        row.failure = { name: 'RowTimeout', message: controller.signal.reason.message };
      }
    },
  };
}

export function boundedHooks(context, trace, persist, milliseconds = 30000) {
  let counter = 0;
  return new Proxy(context, {
    get(object, key) {
      if (key === 'after')
        return (callback) => {
          const name = `${trace.route}/${trace.mode ?? 'reads'}/after-${++counter}`;
          return object.after(async (...args) => {
            try {
              await boundedStage(trace, name, () => callback(...args), milliseconds);
            } finally {
              await persist();
            }
          });
        };
      const value = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export async function boundedStage(trace, name, run, milliseconds = 30000) {
  const row = { name, step: name, status: 'running' };
  (trace.stages ??= []).push(row);
  const deadline = rowDeadline(row, milliseconds);
  console.log(`cdp675 stage start ${name}`);
  try {
    const result = await deadline.wait(run);
    row.status = 'pass';
    return result;
  } catch (error) {
    row.status = 'finding';
    row.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    deadline.end();
    console.log(`cdp675 stage end ${name} ${row.status}`);
  }
}
