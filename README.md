# slicc-bios

A slim loader for [SLICC](https://github.com/ai-ecoverse/slicc), from the boot-process idea in [ai-ecoverse/slicc#3793](https://github.com/ai-ecoverse/slicc/issues/3793): load a small BIOS first, put everything else into OPFS, and serve the UI from there.

The page shows six boot steps as they run:

1. **Acquire OPFS** – open the origin private file system and ask for persistent storage.
2. **Create installer worker** – start `installer.js`, a shared worker that does all of the BIOS's OPFS writes and is shared by every tab.
3. **Install packages from npm into OPFS** – the installer reads [`src/packages/package-lock.json`](src/packages/package-lock.json), the lockfile the BIOS ships with. For every locked package it downloads the tarball from `registry.npmjs.org` and checks its `integrity`, then unpacks it with the built-in `DecompressionStream` and [`modern-tar`](https://github.com/ayuhito/modern-tar) into OPFS at its lockfile path (`node_modules/…`). It records a receipt in `var/lib/bios/`. Packages whose receipt matches the lockfile's integrity and whose files are still there are not downloaded again, so pinning a new version replaces just that package. Replacing a package keeps its nested `node_modules`, and packages the lockfile no longer lists are deleted along with their receipts. A package that pnpm already installed at the locked version (by `node_modules/.modules.yaml` and its own `package.json`) counts as current too, and gets a receipt so it can be pruned later. Last, the installer copies the deployment's `package.json` and `pnpm-lock.yaml` to the OPFS root for pnpm, and the lockfile once more to `var/lib/slicc/pnpm-lock.yaml`, which records what is installed (see [Updates](#updates)).
4. **Add UI page to OPFS** – the installer copies `src/seed/` to `os/` in OPFS. This is a stand-in until the UI ships as a downloadable asset.
5. **Intercept same-origin requests** – `sw.js` answers any in-scope request whose path exists in OPFS and passes everything else to the network. Everything it serves from OPFS carries `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`, so the UI page and the workers it starts are cross-origin isolated.
6. **Serve UI from OPFS** – navigate to `os/` (keeping the URL fragment) with a cross-document view transition. That page imports [`@ai-ecoverse/slicc-kernel`](https://github.com/ai-ecoverse/slicc-kernel) and [`@ai-ecoverse/slicc-spectrum`](https://github.com/ai-ecoverse/slicc-spectrum) from `node_modules/` in OPFS through an import map, starts the kernel on the OPFS root and boots SLICC's UI, `<slicc-app>`, on spectrum's kernel model (see [UI](#ui)). Commands come from the installed packages: `bash`, coreutils, `grep`, `sed`, findutils, `gawk`, `jq`, `less`, `curl` and `pnpm`. The shell starts in `/home`, and whatever it writes stays in OPFS across reloads. The kernel terminates HTTPS with `wasm-tls-engine`, so `curl https://…` works over whichever transport is picked (see [Network](#network)). `wasm-git` is left out for its size (53 MB); it can come later through pnpm.

## UI

`os/` is `<slicc-app>` from `@ai-ecoverse/slicc-spectrum/ui` on `createKernelModel` from `@ai-ecoverse/slicc-spectrum/kernel`. There's no agent yet (that waits for [slicc-agent#2](https://github.com/ai-ecoverse/slicc-agent/issues/2)), so the page offers only the two sections that work without one:

- **Terminal:** `bash -i` sessions on the kernel, starting in `/home`, as many as you open with **+**.
- **Files:** the OPFS root as a tree. `/node_modules`, pnpm's store and `/home/.cache` are listed but not scanned. The tree follows what the terminal writes (a rescan every 2 s and on `FileSystemObserver` records). Files open in tabs, and **Edit** turns a tab into a text area that **Save** or `Mod+S` writes back to OPFS.

Each screen class has its own layout, kept in `localStorage` (`slicc-os.layout.<screen>`). On desktop and tablet the terminal is in the middle, files are on the left, and file tabs open between them. On a phone it's the terminal, with files in the bottom rail. Chat, agents, changes, the browser, memory, the monitor and settings come back as their backends land. Adobe Clean comes from `/fonts/`, which the sliccy-ai worker serves on every host.

### Grammars

Spectrum bundles 16 syntax languages; the rest come from `@shikijs/langs` and `@shikijs/themes` (725 and 135 files). They aren't part of the first boot. They're a separate pnpm project, [`src/packages/grammars/`](src/packages/grammars/), deployed next to the BIOS's lockfiles:

1. **Until they're installed,** the UI loads grammars from jsDelivr.
2. **After every update check,** `os/grammars.js` compares the deployed `packages/grammars/pnpm-lock.yaml` with `var/lib/slicc/grammars/pnpm-lock.yaml`. If they differ, it writes the manifest and lockfile to `/opt/grammars` and runs `pnpm install --frozen-lockfile --trust-lockfile` there, under its own Web Lock, `slicc-grammars`, so a long install never holds up the BIOS in another tab. Only once pnpm succeeds does it record the lockfile.
3. **Once they're installed,** `grammarBase` points at `/opt/grammars/node_modules/@shikijs/`, so highlighting works offline from then on. If pnpm fails, the page stays on jsDelivr, logs a warning, and tries again at the next check.

The Files panel lists `/opt/grammars/node_modules` but doesn't scan it.

The network and update notices sit in the UI's status bar.

## Network

Before the kernel starts, `os/transport.js` picks how programs reach the network. The first of these that applies wins:

1. **A local proxy:** [slicc-node](https://github.com/ai-ecoverse/slicc-node) (`npx @ai-ecoverse/slicc-node`) or slicc-swift. The launcher opens `https://seven.sliccy.ai/#proxy=<url>&key=<key>`. The page takes both from the fragment and removes them from the address bar. It accepts only a plain `http://` origin on `127.0.0.1`, `localhost` or `[::1]`, so a link can't send traffic elsewhere. It keeps them in IndexedDB (`slicc-os`, store `transport`), so a reload keeps using the proxy. Each load checks the proxy with `checkLocalProxy`. If the proxy refuses the key (every proxy process mints a new one), isn't a proxy, or doesn't answer although the page may reach loopback, the page forgets it and falls through. It keeps the proxy, and still falls through, when Chrome's Local Network Access permission is denied, or when nothing answered while the permission is undecided (Chrome asks only once it has a connection, so a dismissed prompt and a stopped proxy look the same).
2. **[slicc-extension](https://github.com/ai-ecoverse/slicc-extension):** when the extension defines `globalThis.sliccExtension`, the kernel uses `fetchTransport({ fetch: sliccExtension.fetch })`.
3. **The page's own `fetch`:** `fetchTransport()`, bound by CORS. A request CORS stops is answered `502` with a hint to run slicc-node or install slicc-extension, which `curl` prints.

The choice is in `document.documentElement.dataset.transport`: `local-proxy`, `extension` or `page`. An item in the status bar, `os/network.js`, names it too. When a local proxy was asked for but isn't used, the line says why (blocked by the permission, not answering, or refusing the key) and what the page uses instead. Where trying again can help, it offers **Retry**: Retry checks the proxy again and reloads the page onto it once it answers. The item is plain light DOM slotted into `<slicc-app>`'s status bar (`slot="status"`).

## Updates

A running install updates itself from the deployment it was booted from, package by package, without a reload:

1. **Notice.** `os/update.js` fetches `packages/pnpm-lock.yaml` from the deployment when the UI starts, whenever the tab becomes visible again, and every 15 minutes. If it differs from `var/lib/slicc/pnpm-lock.yaml` in OPFS, there is an update.
2. **Install.** It writes the deployment's `package.json` and `pnpm-lock.yaml` to the OPFS root and runs `pnpm install --frozen-lockfile --trust-lockfile` there in the page's kernel. [`@ai-ecoverse/wasi-pnpm`](https://www.npmjs.com/package/@ai-ecoverse/wasi-pnpm) is one of the bootstrap packages, so pnpm is always installed. pnpm's hoisted, copying layout keeps `node_modules/` exactly where the BIOS puts it, and it only rewrites packages whose locked version changed. Its store lives in OPFS under `/home/.local/share/pnpm/`. Only when pnpm succeeds does the updater write the lockfile to `var/lib/slicc/pnpm-lock.yaml`, so an update that fails or is cut short by closing the tab is tried again by the next check.
3. **Switch over.** Packages are updated in place. A program reads its wasm and glue when it starts, so running processes, the interactive `bash` included, keep the code they started with, and every process started afterwards gets the new version. The page itself keeps the kernel and terminals it loaded. An item in the status bar lists what changed and offers **Reload**, which navigates to the BIOS with a view transition. The BIOS then picks up a new `sw.js` and seed, finds every package current (its receipt, or pnpm's `.modules.yaml` and the installed version, match), and goes back to `os/`. Files in OPFS, `/home` included, are not touched.

Both the BIOS installer and the updater take the Web Lock `slicc-packages`, so tabs never install at the same time.

Decisions, from [#11](https://github.com/ai-ecoverse/slicc-bios/issues/11):

- **The newest lockfile comes from the BIOS deployment, not from npm.** Every deploy already publishes `src/packages/` next to the BIOS, `sw.js` and the seed, and CI tested that exact combination. A branch host updates from its own branch, the host's `cache-control: no-cache` and ETag keep polling cheap, and nothing extra has to be published. Taking the lockfile from npm would need a release package that sits outside this repo's CI, and the deployed BIOS and seed could drift away from the packages it pins.
- **Two lockfiles from one `package.json`.** `package-lock.json` stays for the bootstrap: it carries each tarball URL and its hoisted path, so the installer needs neither a YAML parser nor a hoisting algorithm. `pnpm-lock.yaml` drives every update after that, and a test keeps both pinned to the same versions and integrity. Once pnpm has run, the BIOS trusts pnpm's record of what it installed, so a reload does not download a package pnpm already updated.
- **In place, not versioned directories.** OPFS has no hard links, so a versioned directory would copy every file of every package for every update, which is the slow part (the kernel's per-file OPFS writes). In place, pnpm copies only the packages that changed, and the kernel re-reads its command catalog on every run.

Limits:

- The first update after a bootstrap has no pnpm state yet, so pnpm downloads every package once into its store and copies all of them. Later updates touch only what changed.
- Between an in-place update of `slicc-kernel` and the reload, the old kernel worker starts new processes with the new `process-worker.js`. The two are built together, so this works as long as their protocol doesn't change; a kernel that loads its process worker once would remove the gap.
- Packages added to `/package.json` by hand are removed by the next update. Projects of your own belong in `/home`.
- Emscripten programs see only the directories at `/`, so `ls /` and `cat /pnpm-lock.yaml` don't find the two files; WASI programs such as `pnpm` (`cd / && pnpm install`) do.
- An update of the seed (`os/`) or `sw.js` alone has no lockfile change, so it arrives with the next boot through the BIOS.

## Develop

```sh
npm install
npm start
npm test
npm run lint
```

`npm start` serves `src/` on <http://127.0.0.1:8080/>. There is no build step. To change what the BIOS installs, edit `src/packages/package.json` and refresh both lockfiles in that directory with `npm install --package-lock-only` and `npx pnpm@12 install --lockfile-only`; npm and pnpm resolve the dependency tree, the BIOS and the updater only replay it. A test fails when the two lockfiles pin different packages. `npm install` also installs the [lefthook](https://lefthook.dev) pre-commit hook, which runs Biome, the no-comment check, the no-unit-tests-in-git guard, and the diff-coverage check described below.

`npm test` runs the integration tests with `node --test` against Chromium (fetched by `playwright-core`), driven directly over the DevTools protocol by the [harness from slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web#integration-test-harness); `test/integration/chrome.mjs` only says what to serve and which CDN requests to intercept. Every run leaves behind:

- `coverage/` – V8 coverage of the page, the shared worker, and the service worker as `lcov.info` plus an HTML report.
- `artifacts/<suite>/<test>/` – a `.cpuprofile` per page and worker, the kernel's workers included, for every document and test (open them in the DevTools Performance panel or [speedscope](https://www.speedscope.app)) and a screenshot of each tab at the end of the test.
- `artifacts/hotspots.md` – the functions in `src/` with the most self time across all profiles, also printed after the test run and added to the CI job summary.

The profiles are recorded with coverage switched on, so absolute timings run high. Use them to compare functions with each other rather than as real-world numbers.

## Hosting

`main` is live at <https://seven.sliccy.ai/>, and every other branch at `https://<branch>.sliccy.ai/`, where the branch name is lowercased and runs of anything but letters and digits become `-` (`feat/edge-hosting` → <https://feat-edge-hosting.sliccy.ai/>). Each host is its own origin, so a branch gets its own OPFS and service worker and can't disturb `seven`.

The hosts are served by the [sliccy-ai](https://github.com/ai-ecoverse/sliccy-ai) worker from the R2 bucket `slicc-bios`. This repo only publishes into that bucket:

- [`edge/publish.mjs`](edge/publish.mjs) `<branch>` uploads `src/` to `seven/` for `main` and to `branches/<label>/` for every other branch, and deletes what the previous upload had and this one doesn't. A manifest next to it (`seven.json`, `branches/<label>.json`) records which branch owns the label, so two branches that map to the same label can't overwrite each other.
- The bucket expires everything under `branches/` 30 days after upload. Every push uploads all files again, so a branch stays up while it's active and disappears a month after its last push. Nothing needs to be cleaned up when a branch is deleted.
- [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) publishes on every push. It needs the `CLOUDFLARE_API_TOKEN` secret, an account token with Workers R2 Storage Write.

## Rules

The Biome, lefthook, Renovate and CI configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web), which also provides the `slicc-*` commands below.

- **No comments.** `slicc-lint-comments` runs the [slicc no-comment checker](https://github.com/ai-ecoverse/slicc/tree/main/packages/dev-tools/no-comment) over the tree.
- **Unit tests stay out of git.** Write them in `test/unit/`, which is gitignored, and run them with `npm run test:unit`. `slicc-no-unit-tests` fails if a unit test gets committed anyway.
- **Changed code must be covered.** When a commit touches JavaScript in `src/`, lefthook runs the local unit tests with coverage and [`diff-cover`](https://github.com/Bachmann1234/diff_cover) requires every staged line to be executed. Files that no unit test loads count as 0%. This needs [uv](https://docs.astral.sh/uv/) for `uvx`.
- **Integration tests run in CI.** `test/integration/` is committed and runs on every push and pull request; run it locally with `npm test`. Their coverage report, CPU profiles, and screenshots are uploaded as CI artifacts for inspection, not used as a gate.
