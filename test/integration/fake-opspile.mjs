const json = (status, body, headers = []) => ({
  status,
  headers: [
    ['content-type', 'application/json'],
    ['cache-control', 'private, no-store'],
    ...headers,
  ],
  body: Buffer.from(JSON.stringify(body)),
});

const header = (request, name) => request.headers.find(([key]) => key.toLowerCase() === name)?.[1];

export function fakeOpspile({ accounts }) {
  const state = {
    threads: [
      {
        id: 'sup-preview',
        title: 'Preview builds fail',
        resolved: false,
        messages: [
          {
            id: 'm1',
            at: '2026-11-20T09:00:00.000Z',
            kind: 'customer',
            name: 'Mara Lind',
            body: 'Builds fail since Monday.',
            rev: 0,
          },
          {
            id: 'm2',
            at: '2026-11-20T10:00:00.000Z',
            kind: 'staff',
            name: 'Adobe Support',
            body: 'Looking into it.',
            rev: 0,
          },
        ],
        read: 'm1',
      },
      {
        id: 'sup-editor',
        title: 'Editor is slow',
        resolved: true,
        messages: [
          {
            id: 'm3',
            at: '2026-11-18T09:00:00.000Z',
            kind: 'customer',
            name: 'Mara Lind',
            body: 'The editor is slow.',
            rev: 0,
          },
          {
            id: 'm4',
            at: '2026-11-18T11:00:00.000Z',
            kind: 'staff',
            name: 'Adobe Support',
            body: 'Fixed.',
            rev: 1,
          },
        ],
        read: 'm4',
      },
    ],
    events: [],
    receipts: new Map(),
    calls: [],
    fail: [],
    audience: 'shared',
    next: 5,
  };
  const unread = (thread) => {
    const at = thread.messages.findIndex((m) => m.id === thread.read);
    return thread.messages.slice(at + 1).filter((m) => m.kind !== 'customer' && !m.deleted).length;
  };
  const unreadThreads = () => state.threads.filter((thread) => unread(thread) > 0).length;
  const item = (thread) => ({
    id: thread.id,
    title: thread.title,
    resolved: thread.resolved,
    unread: unread(thread),
    lastActivity: thread.messages.at(-1).at,
  });
  const event = (threadId, reason) => {
    state.events.push({
      id: `ev-${state.events.length + 1}`,
      type: 'thread.updated',
      threadId,
      reason,
    });
  };

  function answer(request, raw) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^(\/7)?\/api\/support\//, '');
    const token = header(request, 'authorization')?.replace(/^Bearer /, '');
    const key = header(request, 'idempotency-key');
    const body = raw.length ? JSON.parse(raw.toString()) : null;
    state.calls.push({ method: request.method, path, search: url.search, token, key, body });
    const account = accounts[token];
    if (!account) return json(401, { error: { code: 'invalid_assertion' } });
    if (account.auto) account.enrolled = true;
    if (!account.enrolled)
      return json(403, {
        error: {
          code: 'not_enrolled',
          ...(account.request ? { request: account.request } : {}),
          ...(account.reason ? { reason: account.reason } : {}),
        },
      });
    const failing = state.fail.findIndex((rule) => rule.path.test(path));
    if (failing !== -1) {
      const [rule] = state.fail.splice(failing, 1);
      return json(rule.status, { error: { code: rule.code } }, rule.headers ?? []);
    }
    if (request.method === 'GET' && path === 'threads') {
      const items = [...state.threads]
        .sort((a, b) => b.messages.at(-1).at.localeCompare(a.messages.at(-1).at))
        .map(item);
      return json(200, {
        items,
        next: null,
        unreadThreads: unreadThreads(),
        changeCursor: `c${state.events.length}`,
        ...(state.audience ? { audience: state.audience } : {}),
      });
    }
    if (request.method === 'GET' && path === 'changes') {
      const after = Number(url.searchParams.get('after')?.slice(1));
      if (!Number.isInteger(after)) return json(400, { error: { code: 'invalid_cursor' } });
      return json(200, {
        events: state.events.slice(after, after + 100),
        next: `c${Math.min(state.events.length, after + 100)}`,
        hasMore: after + 100 < state.events.length,
        unreadThreads: unreadThreads(),
      });
    }
    const found = /^threads\/([^/]+)/.exec(path);
    const thread = found && state.threads.find((one) => one.id === found[1]);
    if (found && !thread && path !== 'threads') return json(404, { error: { code: 'not_found' } });
    if (request.method === 'GET' && thread)
      return json(200, {
        id: thread.id,
        title: thread.title,
        resolved: thread.resolved,
        messages: thread.messages.map((m) => ({ ...m, deleted: false })),
        next: null,
      });
    if (request.method === 'POST') {
      if (!key) return json(400, { error: { code: 'invalid_input' } });
      const receipt = state.receipts.get(key);
      const input = JSON.stringify({ path, body });
      if (receipt && receipt.input !== input) return json(409, { error: { code: 'key_conflict' } });
      if (receipt) return json(200, receipt.result);
      const id = `m${state.next++}`;
      const message = {
        id,
        at: new Date().toISOString(),
        kind: 'customer',
        name: account.name,
        body: body.body,
        rev: 0,
      };
      let result;
      if (path === 'threads') {
        const root = `sup-${id}`;
        state.threads.push({
          id: root,
          title: body.title,
          resolved: false,
          messages: [{ ...message, id: root }],
          read: root,
        });
        event(root, 'created');
        result = { threadId: root, channelId: 'ch-1', channelName: 'Mill support', requestId: key };
      } else {
        thread.messages.push(message);
        thread.read = id;
        event(thread.id, 'reply');
        result = { id, threadId: thread.id };
      }
      state.receipts.set(key, { input, result });
      return json(201, result);
    }
    if (request.method === 'PUT' && thread && path.endsWith('/read')) {
      thread.read = body.through;
      event(thread.id, 'read');
      return json(200, { unreadThreads: unreadThreads() });
    }
    return json(404, { error: { code: 'not_found' } });
  }

  return {
    state,
    answer,
    supportReply(threadId, text) {
      const thread = state.threads.find((one) => one.id === threadId);
      thread.messages.push({
        id: `m${state.next++}`,
        at: new Date().toISOString(),
        kind: 'staff',
        name: 'Adobe Support',
        body: text,
        rev: 0,
      });
      event(threadId, 'reply');
    },
  };
}
