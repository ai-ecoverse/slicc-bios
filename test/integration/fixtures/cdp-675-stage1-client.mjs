const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(work, ms) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Stage1 fixture deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitEvent(client, session, start, predicate, budget) {
  const until = Date.now() + budget;
  do {
    const event = client.events
      .slice(start)
      .find((item) => item.sessionId === session && predicate(item));
    if (event) return event;
    await sleep(10);
  } while (Date.now() < until);
  throw new Error('Stage1 fixture event deadline');
}

export async function stage1ClientRow({
  row,
  client,
  session,
  navigate,
  read,
  lifecycle,
  audit,
  budget = 5000,
}) {
  const trace = [];
  const send = async (method, params = {}) => {
    trace.push({ method, params, sessionId: session });
    return bounded(client.send(method, params, session), budget);
  };
  const result = { id: row.id, trace };
  let enabled = false;
  let breakpoint;
  let resumed = false;
  let ownerGone = false;
  let publicationStart;
  try {
    let freeRefused = false;
    try {
      await send('Debugger.pause');
    } catch (error) {
      freeRefused = /^slicc: refused:/.test(error.message);
    }
    if (!freeRefused) throw new Error('Stage1 fixture has no explicit free-pause refusal');
    await send('Debugger.enable');
    enabled = true;
    const installed = await send('Debugger.setInstrumentationBreakpoint', {
      instrumentation: 'beforeScriptExecution',
    });
    breakpoint = installed.breakpointId;
    if (typeof breakpoint !== 'string')
      throw new Error('Stage1 fixture has no instrumentation identifier');
    result.admitted = true;
    const start = client.events.length;
    publicationStart = start;
    const navigation = await bounded(
      navigate(row, row.mode === 'pending-pause-hop' ? 'ordinary' : 'destination'),
      budget
    );
    if (navigation?.stimulated !== true)
      throw new Error('Stage1 fixture navigation was not stimulated');
    if (row.mode === 'protected-hop' || row.mode === 'late-foreign-world') {
      const evidence = await bounded(read(row), budget);
      const forwarded = client.events
        .slice(start)
        .filter(
          (event) =>
            event.sessionId === session &&
            /^Debugger\.(paused|scriptParsed|scriptFailedToParse|breakpointResolved)$/.test(
              event.method
            )
        );
      result.published = forwarded.length !== 0;
      result.committed = evidence.committed;
      result.released = evidence.released;
      result.rescue = await bounded(audit(row), budget);
      return result;
    }
    const instrumentation = await waitEvent(
      client,
      session,
      start,
      (event) => event.method === 'Debugger.paused' && event.params.reason === 'instrumentation',
      budget
    );
    const frame = instrumentation.params.callFrames?.[0];
    if (!frame?.callFrameId || !frame.location?.scriptId)
      throw new Error('Stage1 fixture has no usable instrumentation frame');
    const conversionStart = client.events.length;
    if (row.mode === 'pending-pause-hop') {
      publicationStart = conversionStart;
      const pending = send('Debugger.pause').then(
        () => true,
        () => false
      );
      const hop = await bounded(navigate(row, 'pending-pause'), budget);
      if (hop?.stimulated !== true)
        throw new Error('Stage1 fixture pending hop was not stimulated');
      await pending;
      const evidence = await bounded(read(row), budget);
      result.published = client.events
        .slice(conversionStart)
        .some(
          (event) =>
            event.sessionId === session &&
            /^Debugger\.(paused|scriptParsed|scriptFailedToParse|breakpointResolved)$/.test(
              event.method
            )
        );
      result.committed = evidence.committed;
      result.released = evidence.released;
      result.rescue = await bounded(audit(row), budget);
      return result;
    }
    await send('Debugger.pause');
    await send('Debugger.resume');
    const normal = await waitEvent(
      client,
      session,
      conversionStart,
      (event) => event.method === 'Debugger.paused' && event.params.reason !== 'instrumentation',
      budget
    );
    const normalFrame = normal.params.callFrames?.[0];
    result.converted =
      normalFrame?.location?.scriptId === frame.location.scriptId &&
      normalFrame?.location?.lineNumber === frame.location.lineNumber &&
      normalFrame?.location?.columnNumber === frame.location.columnNumber;
    const tree = await send('Page.getFrameTree');
    const source = await send('Debugger.getScriptSource', {
      scriptId: normalFrame.location.scriptId,
    });
    const evaluated = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: normalFrame.callFrameId,
      expression: '21 * 2',
      returnByValue: true,
    });
    const evidence = await bounded(read(row, tree), budget);
    result.liveReads =
      evidence.ordinary === true &&
      evidence.generationCurrent === true &&
      typeof source.scriptSource === 'string' &&
      source.scriptSource.length > 0 &&
      evaluated.result?.value === 42;
    result.rescue = await bounded(audit(row), budget);
    if (row.mode === 'install') {
      await send('Debugger.removeBreakpoint', { breakpointId: breakpoint });
      breakpoint = undefined;
      await send('Debugger.resume');
      resumed = true;
      await send('Debugger.disable');
      enabled = false;
    } else {
      await bounded(lifecycle(row), budget);
      ownerGone = true;
      result.rescue = await bounded(audit(row), budget);
    }
    result.released = (await bounded(read(row), budget)).released;
    return result;
  } finally {
    if (!ownerGone) {
      if (breakpoint)
        await send('Debugger.removeBreakpoint', { breakpointId: breakpoint }).catch(() => {});
      if (enabled && !resumed) await send('Debugger.resume').catch(() => {});
      if (enabled) await send('Debugger.disable').catch(() => {});
    }
    if ('published' in result)
      result.published = client.events
        .slice(publicationStart)
        .some(
          (event) =>
            event.sessionId === session &&
            /^Debugger\.(paused|scriptParsed|scriptFailedToParse|breakpointResolved)$/.test(
              event.method
            )
        );
  }
}

export function stage1RowFailures(row, result, requiredRescue) {
  const failures = Object.entries(row.expected)
    .filter(([key, expected]) => result[key] !== expected)
    .map(([key]) => key);
  if (row.requires?.includes('privateRescueAudit')) {
    for (const [key, expected] of Object.entries(requiredRescue)) {
      if (result.rescue?.[key] !== expected) failures.push(`rescue.${key}`);
    }
  }
  return failures;
}
