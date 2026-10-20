import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API, apiOrigin, createReleases, ORIGIN_KEY, REGISTRY } from '../../src/seed/releases.js';

const stored = (value) => ({ getItem: (key) => (key === ORIGIN_KEY ? value : null) });

function memory() {
  const map = new Map();
  return { get: async (key) => map.get(key), put: async (key, value) => void map.set(key, value) };
}

test('on seven.sliccy.ai and www.sliccy.ai a stored releases origin is refused with one report, and the page asks only api.github.com', async () => {
  for (const host of ['https://seven.sliccy.ai', 'https://www.sliccy.ai']) {
    const reports = [];
    const origin = apiOrigin({
      origin: host,
      storage: stored('https://forged.test'),
      report: (message) => reports.push(message),
    });
    assert.equal(origin, API);
    assert.deepEqual(reports, [`releases: ${ORIGIN_KEY} is refused on ${host}; using ${API}`]);
    const asked = [];
    const fetcher = async (url) => {
      asked.push(String(url));
      return Response.json([]);
    };
    await createReleases({ fetcher, store: memory(), origin })
      .round()
      .items('ai-ecoverse/slicc-kernel', { from: '1.0.0', to: '1.0.0', own: true, short: null });
    assert.deepEqual(asked, [`${API}/repos/ai-ecoverse/slicc-kernel/releases?per_page=100&page=1`]);
  }
  const quiet = [];
  assert.equal(
    apiOrigin({
      origin: 'https://seven.sliccy.ai',
      storage: stored(null),
      report: (m) => quiet.push(m),
    }),
    API
  );
  assert.deepEqual(quiet, []);
  assert.equal(
    apiOrigin({
      origin: 'https://bb-x.sliccy.ai',
      storage: stored('http://127.0.0.1:9'),
      report: () => {},
    }),
    'http://127.0.0.1:9'
  );
});

test('GitHub and the npm registry are asked without credentials, a referrer or any header but Accept and If-None-Match', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).startsWith(REGISTRY)) {
      return Response.json({ repository: 'git+https://github.com/ai-ecoverse/mcpcat.git' });
    }
    return Response.json([], { headers: { etag: '"one"' } });
  };
  const store = memory();
  const releases = createReleases({ fetcher, store, origin: API });
  const round = releases.round();
  assert.equal(await round.repository('@ai-ecoverse/mcpcat', '0.17.0'), 'ai-ecoverse/mcpcat');
  await round.items('ai-ecoverse/mcpcat', { from: null, to: '0.17.0', own: true, short: 'mcpcat' });
  await releases
    .round()
    .items('ai-ecoverse/mcpcat', { from: null, to: '0.17.0', own: true, short: 'mcpcat' });
  assert.equal(calls[0][0], `${REGISTRY}/@ai-ecoverse%2Fmcpcat/0.17.0`);
  for (const [url, init] of calls) {
    assert.equal(init.credentials, 'omit', url);
    assert.equal(init.referrerPolicy, 'no-referrer', url);
    for (const name of Object.keys(init.headers ?? {})) {
      assert.ok(['accept', 'if-none-match'].includes(name), `${url} sent ${name}`);
    }
  }
  assert.equal(calls.at(-1)[1].headers['if-none-match'], '"one"');
});

test('a release whose page is not on github.com, or a package whose repository is outside ai-ecoverse, never reaches a row', async () => {
  const { createNotes } = await import('../../src/seed/releases.js');
  const fetcher = async (url) => {
    const at = String(url);
    if (at.startsWith(REGISTRY)) {
      const name = decodeURIComponent(new URL(at).pathname.split('/')[1]);
      const repository = {
        '@ai-ecoverse/mcpcat': 'git+https://github.com/ai-ecoverse/mcpcat.git',
        thirdparty: 'git+https://github.com/someone/thirdparty.git',
        'gitlab-tool': 'git+https://gitlab.com/someone/gitlab-tool.git',
      }[name];
      return Response.json({ repository });
    }
    if (at.includes('/repos/ai-ecoverse/mcpcat/')) {
      return Response.json([
        { tag_name: 'v0.17.0', html_url: 'https://forged.test/v0.17.0', body: 'forged' },
        {
          tag_name: 'v0.16.3',
          html_url: 'https://github.com/ai-ecoverse/mcpcat/releases/tag/v0.16.3',
          body: 'real',
        },
      ]);
    }
    throw new Error(`asked ${at}`);
  };
  const notes = createNotes({
    releases: createReleases({ fetcher, store: memory(), origin: API }),
  });
  const rows = [
    { id: 'mcpcat', package: '@ai-ecoverse/mcpcat', version: '0.16.3', offered: '0.17.0' },
    { id: 'thirdparty', package: 'thirdparty', version: null, offered: '1.0.0' },
    { id: 'gitlab', package: 'gitlab-tool', version: null, offered: '1.0.0' },
  ];
  await notes.packages(rows);
  const shown = notes.annotate(rows);
  assert.deepEqual(shown[0].releases, [
    {
      version: '0.16.3',
      url: 'https://github.com/ai-ecoverse/mcpcat/releases/tag/v0.16.3',
      notes: 'real',
    },
  ]);
  assert.equal('releases' in shown[1], false);
  assert.equal('releases' in shown[2], false);
});

test('an out-of-order backport below the installed release on page 1 does not stop the paging, so in-range releases on page 2 still reach the row', async () => {
  const page = (versions) =>
    versions.map((version) => ({
      tag_name: `v${version}`,
      html_url: `https://github.com/ai-ecoverse/slicc-kernel/releases/tag/v${version}`,
      body: `notes ${version}`,
    }));
  const first = page(['1.0.1', ...Array.from({ length: 99 }, (_, i) => `2.0.${200 - i}`)]);
  const second = page(['2.0.101', '2.0.100', '2.0.99']);
  const asked = [];
  const fetcher = async (url) => {
    asked.push(String(url));
    const n = Number(new URL(String(url)).searchParams.get('page'));
    return Response.json(n === 1 ? first : n === 2 ? second : []);
  };
  const items = await createReleases({ fetcher, store: memory(), origin: API })
    .round()
    .items('ai-ecoverse/slicc-kernel', { from: '2.0.99', to: '2.0.200', own: true, short: null });
  assert.equal(asked.length, 2);
  const versions = items.map(({ tag }) => tag);
  assert.ok(versions.includes('v2.0.100'));
  assert.ok(versions.includes('v2.0.99'));
});

test('a component installed for the first time during a check gets its releases in that same check', async () => {
  const { createNotes } = await import('../../src/seed/releases.js');
  const asked = [];
  const fetcher = async (url) => {
    asked.push(String(url));
    return Response.json([
      {
        tag_name: 'v6.14.3',
        html_url: 'https://github.com/ai-ecoverse/slicc-agent/releases/tag/v6.14.3',
        body: 'agent notes',
      },
    ]);
  };
  const items = { agent: { from: null, to: null } };
  let renoted = 0;
  const updates = { get: (id) => items[id], renote: () => (renoted += 1) };
  const notes = createNotes({
    releases: createReleases({ fetcher, store: memory(), origin: API }),
  });
  await notes.prepare(updates);
  assert.deepEqual(asked, []);
  const prepared = renoted;
  items.agent = { from: '6.14.3', to: '6.14.3' };
  assert.equal(notes.pick('agent', '6.14.3', '6.14.3'), undefined);
  for (let i = 0; i < 50 && renoted === prepared; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(renoted, prepared + 1);
  assert.deepEqual(notes.pick('agent', '6.14.3', '6.14.3'), [
    {
      version: '6.14.3',
      url: 'https://github.com/ai-ecoverse/slicc-agent/releases/tag/v6.14.3',
      notes: 'agent notes',
    },
  ]);
  assert.deepEqual(asked, [`${API}/repos/ai-ecoverse/slicc-agent/releases?per_page=100&page=1`]);
});

test('when page 1 is unchanged, a release edited on page 2 still reaches the row: every later page is revalidated with its own ETag', async () => {
  const page = (versions, body) =>
    versions.map((version) => ({
      tag_name: `v${version}`,
      html_url: `https://github.com/ai-ecoverse/slicc-kernel/releases/tag/v${version}`,
      body: `${body} ${version}`,
    }));
  const first = page(
    Array.from({ length: 100 }, (_, i) => `2.0.${200 - i}`),
    'notes'
  );
  const pages = [first, page(['2.0.100', '2.0.99'], 'notes')];
  const tags = ['"one"', '"two"'];
  const sent = [];
  const fetcher = async (url, init) => {
    const n = Number(new URL(String(url)).searchParams.get('page'));
    sent.push([n, init.headers['if-none-match'] ?? null]);
    if (init.headers['if-none-match'] === tags[n - 1]) return new Response(null, { status: 304 });
    return Response.json(pages[n - 1], { headers: { etag: tags[n - 1] } });
  };
  const releases = createReleases({ fetcher, store: memory(), origin: API });
  const want = { from: '2.0.99', to: '2.0.200', own: true, short: null };
  await releases.round().items('ai-ecoverse/slicc-kernel', want);
  pages[1] = page(['2.0.100', '2.0.99'], 'edited');
  tags[1] = '"two-edited"';
  const items = await releases.round().items('ai-ecoverse/slicc-kernel', want);
  assert.deepEqual(sent, [
    [1, null],
    [2, null],
    [1, '"one"'],
    [2, '"two"'],
  ]);
  assert.equal(items.find(({ tag }) => tag === 'v2.0.100').body, 'edited 2.0.100');
});

test('when GitHub answers within the wait, a row the check never rewrites, like an inactive Tailscale, still shows its releases', async () => {
  const { createNotes } = await import('../../src/seed/releases.js');
  const { createUpdates } = await import('../../src/seed/updates.js');
  const fetcher = async (url) =>
    String(url).includes('/wasm-tailscale/')
      ? Response.json([
          {
            tag_name: 'v1.104.1-9',
            html_url: 'https://github.com/ai-ecoverse/wasm-tailscale/releases/tag/v1.104.1-9',
            body: 'tailscale notes',
          },
        ])
      : Response.json([]);
  const notes = createNotes({
    releases: createReleases({ fetcher, store: memory(), origin: API }),
  });
  const updates = createUpdates({ notes });
  updates.set('tailscale', { from: '1.104.1-9', to: '1.104.1-9' });
  assert.equal('releases' in updates.get('tailscale'), false);
  await notes.prepare(updates);
  assert.deepEqual(updates.get('tailscale').releases, [
    {
      version: '1.104.1-9',
      url: 'https://github.com/ai-ecoverse/wasm-tailscale/releases/tag/v1.104.1-9',
      notes: 'tailscale notes',
    },
  ]);
});
