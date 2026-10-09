# slicc-bios

A slim loader for [SLICC](https://github.com/ai-ecoverse/slicc), from the boot-process idea in [ai-ecoverse/slicc#3793](https://github.com/ai-ecoverse/slicc/issues/3793): load a small BIOS first, put everything else into OPFS, and serve the UI from there.

The page shows six boot steps as they run:

1. **Acquire OPFS** – open the origin private file system and ask for persistent storage.
2. **Create installer worker** – start `installer.js`, a shared worker that does all of the BIOS's OPFS writes and is shared by every tab.
3. **Install packages from npm into OPFS** – the installer reads [`src/packages/package-lock.json`](src/packages/package-lock.json), the lockfile the BIOS ships with. It skips packages that name an `os` or `cpu` (native binaries such as esbuild's, which can't run in a browser). For every other locked package it downloads the tarball from `registry.npmjs.org` and checks its `integrity`, then unpacks it with the built-in `DecompressionStream` and [`modern-tar`](https://github.com/ayuhito/modern-tar) into OPFS at its lockfile path (`node_modules/…`), dropping `.` segments from entry names and skipping any entry with `..`. It records a receipt in `var/lib/bios/`. Packages whose receipt matches the lockfile's integrity and whose files are still there are not downloaded again, so pinning a new version replaces just that package. Replacing a package keeps its nested `node_modules`, and packages the lockfile no longer lists are deleted along with their receipts. A package that pnpm already installed at the locked version (by `node_modules/.modules.yaml` and its own `package.json`) counts as current too, and gets a receipt so it can be pruned later. Last, the installer copies the deployment's `package.json` and `pnpm-lock.yaml` to the OPFS root for pnpm, and the lockfile once more to `var/lib/slicc/pnpm-lock.yaml`, which records what is installed (see [Updates](#updates)).
4. **Add UI page to OPFS** – the installer copies `src/seed/` to `os/` in OPFS. This is a stand-in until the UI ships as a downloadable asset.
5. **Intercept same-origin requests** – `sw.js`, a module service worker, answers any in-scope request whose path exists in OPFS and passes everything else to the network. Everything it serves from OPFS carries `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`, so the UI page and the workers it starts are cross-origin isolated. Scripts it serves get their bare imports resolved (see [Modules](#modules)).
6. **Serve UI from OPFS** – navigate to `os/` (keeping the URL fragment) with a cross-document view transition. That page imports [`@ai-ecoverse/slicc-kernel`](https://github.com/ai-ecoverse/slicc-kernel) and [`@ai-ecoverse/slicc-spectrum`](https://github.com/ai-ecoverse/slicc-spectrum) by name from `node_modules/` in OPFS, starts the kernel on the OPFS root and boots SLICC's UI, `<slicc-app>`, on spectrum's kernel model. The agent comes later, from its own pnpm project (see [Agent](#agent)). Commands come from the installed packages: `bash`, coreutils, `grep`, `sed`, findutils, `gawk`, `diff` (with `cmp`, `sdiff` and `diff3`), `patch`, `rg` (ripgrep), `jq`, `less`, `tree`, `curl`, `mount`, `umount`, `clear`, `tput`, `tset`, `reset`, `pnpm` with its `npm` and `npx` shims, and `playwright-cli` and `curlwright` from slicc-cdp. The shell starts in `/home`, and whatever it writes stays in OPFS across reloads. The kernel terminates HTTPS with `wasm-tls-engine`, so `curl https://…` works over whichever transport is picked (see [Network](#network)). `wasm-git` is left out for its size (53 MB); it can come later through pnpm.

## UI

`os/` is `<slicc-app>` from `@ai-ecoverse/slicc-spectrum/ui` on `createKernelModel` from `@ai-ecoverse/slicc-spectrum/kernel`, with the agent spread over it once it's up. The page offers six sections:

- **Agents:** the rail of cones and their scoops, with each one's status (spectrum ≥ 1.23.0). Selecting a scoop opens its chat, and **Drop** stops it after a confirm. The header picker lists the cones and creates new ones with **New cone**. A cone starts scoops with the `agent` and `subagent` commands that slicc-agent installs in `$PNPM_HOME/bin`: `agent --prompt …` runs a scoop until it answers, and `agent --async …` starts one that reports back to its cone as a lick.
- **Chat:** SLICC's agent, a chat per cone or scoop, once it's installed (see [Agent](#agent)). Its tab joins the terminal's group without taking focus. The model is AWS Bedrock (`us.anthropic.claude-sonnet-5-5` in `us-west-2`) with a Bedrock API key entered under **Settings → Accounts**. The key stays in the agent worker's encrypted credential store. Bedrock sends no CORS headers, so chat needs a local proxy or the extension (see [Network](#network)).
- **Terminal:** `bash -i` sessions on the kernel, starting in `/home`, as many as you open with **+**.
- **Files:** the OPFS root as a tree. `/.slicc` (the agent's own state) and `/.slicc-unlinked` (where the kernel keeps a deleted file that a program still has open, slicc-kernel ≥ 1.37.1) are hidden (`hide`, spectrum ≥ 1.9.0); `/node_modules`, `/opt/agent/node_modules`, pnpm's store and `/home/.cache` are listed but not scanned. The tree follows what the terminal writes (a rescan every 2 s and on `FileSystemObserver` records). Files open in tabs, and **Edit** turns a tab into a text area that **Save** or `Mod+S` writes back to OPFS. Mounted folders show in the tree too (see [Folder mounts](#folder-mounts)).
- **Memory:** what the agent remembers (slicc-agent ≥ 3.14.0, spectrum ≥ 1.28.0). Each scope is one `MEMORY.md`: `/home/.pi/agent/memory/` for everyone and one per cone, `/home/.pi/agent/agent-memory/<path>/` for roles. An entry is a `###` title under a `##` section, with an optional `tag:` line before its body. The agent writes them with `memory_write`, the panel's **Save** and **Forget** write the same files, and a file edited by hand shows up in the panel.
- **Changes:** what agents changed in git repositories, by repository, with the diff and **Accept** or **Revert** per change or for all (slicc-agent ≥ 3.21.1, spectrum ≥ 1.37.0). It sits next to the Freezer, closed by default, and opens from the rail or View. Git isn't preinstalled, so until someone runs `pnpm add -g @ai-ecoverse/wasm-git` it says so and shows that command.
- **Freezer:** every conversation in the session database (slicc-agent ≥ 3.23.0, spectrum ≥ 1.39.0). Live cones show **Open**. A cone deleted with **Delete cone** in Agents (which asks first), an earlier chat left by New chat, or a stopped scoop or agent run stays there with its title, model, kind and message count. **Thaw** brings it back as a cone, and the row then says what it was thawed as. **Remove**, which asks first, deletes its working folders; the conversation stays in the database.
- **Settings:** the theme, the model, thinking, diffs, and the Bedrock and Adobe accounts.
- **Adobe sign-in:** **Connect** on the Adobe account signs in to Adobe IMS. IMS only redirects to `www.sliccy.ai/auth/callback`, and seven is cross-origin isolated, so the popup has no opener to report back to. Which path seven uses depends on where it runs:
  - **On `https://<label>.sliccy.ai`:** seven asks the relay for its own origin (state `{ source: 'origin', origin, nonce }`). The relay navigates the popup to `<origin>/auth/callback`. The service worker serves that page from `os/callback.html`, which hands the redirect to the tab over the same-origin `BroadcastChannel('slicc-sign-in')`, clears the token from its address and closes. Neither slicc-node nor the extension is needed.
  - **Elsewhere, with slicc-extension installed:** the extension signs in with `chrome.identity`.
  - **Elsewhere, through slicc-node:** seven registers a nonce with `POST /api/oauth-state`, sends IMS to the relay's `local` source, and polls `GET /api/oauth-result` once a second.

  Setting `localStorage['slicc-os.sign-in'] = 'relay'` forces the first path on a dev origin; the chat test does that. Seven checks the nonce on every path. While it waits, the Adobe row in Settings › Accounts reads *Signing in…* with **Cancel** (slicc-agent ≥ 3.19.0, spectrum ≥ 1.34.0). The agent calls `login(providerId, options, { signal })`, and Cancel aborts the signal. Cancel, or the 10-minute timeout, stops the wait. On the slicc-node path, Cancel and a `404` also drop the nonce. The token goes to the agent worker's credential store, and the tray shows the weekly budget.

Each screen class has its own layout, kept in `localStorage` (`slicc-os.layout.<screen>`). On desktop and tablet chat and the terminal share the middle, the agents and files are on the left, and file tabs open between them. On a phone it's chat and the terminal, with the agents and files in the bottom rail. Memory opens from the View menu. Changes, the browser and the monitor come back as their backends land. Adobe Clean comes from `/fonts/`, which the sliccy-ai worker serves on every host.

### Folder mounts

A local folder can be mounted into seven as on Linux ([#73](https://github.com/ai-ecoverse/slicc-bios/issues/73)). `os/mounts.js` gives slicc-kernel the hooks it needs:

- **From any shell**, the agent's `bash` included, `mount -t fsa none /mnt/x` (from `@ai-ecoverse/wasm-mount`) mounts an empty drive at once. The Files panel lists `/mnt/x` as waiting for a folder and offers **Insert folder…** (spectrum ≥ 1.32.0). The click opens the folder picker (`showDirectoryPicker`), and the folder goes in without a remount. `umount /mnt/x` ejects it; the folder itself is untouched.
- **From the Files panel** (spectrum ≥ 1.27.0), **Mount a folder…** picks a folder and mounts it at `/mnt/<name>`, then selects it in the tree. A **Mounted** strip lists every folder mount, shell mounts included, each with **Eject**. The files port behind them has `mountFolder(path?)`, `mounts()`, `needsFolder()` and `eject(path)`. `needsFolder()` lists the mount points waiting for a folder, and `mountFolder(path)` inserts one there. The port emits `mounts` when either list changes, then `files`, then `file` for each path that went away, so a tab open on an ejected file notices.
- **Remembered:** `hostfs` mounts, and `fsa` mounts where the profile allows it (see below), are kept in `localStorage` (`slicc-os.mounts`) and mounted again on the next load. The kernel keeps each folder's handle in IndexedDB, so a folder whose permission still holds comes back at once, and one that needs permission again waits in the Files panel, where **Insert folder…** asks for it.
- **Off the record, failing safe:** Chrome 153 crashes the browser when a folder handle goes through IndexedDB in an off-the-record profile (Incognito, or a CDP browser context such as the test harness's), as soon as an `fsa` mount touches the kernel's handle store. The page remembers folders only with positive evidence that the profile isn't off the record: `navigator.storage.persisted()` is granted and the storage quota is at least twice the JavaScript heap limit. Otherwise it gives the kernel `media: false` (slicc-kernel ≥ 1.18.0): folder handles stay in memory and the kernel never opens its `:media` database, while POSIX metadata and the kernel's TLS CA still persist, shared with seven's other kernels. It also neither remembers nor remounts `fsa` mounts then. The kernels seven starts to install the agent and the grammars never mount folders, so they always get `media: false`. In that session mode a folder is asked for again after a reload. Chrome grants persistent storage by engagement, so ordinary profiles can start in session mode too: **Insert folder…** also calls `navigator.storage.persist()`, and when that is granted and the quota check passes, the session switches to remembered. Folders inserted before the switch are asked for once more after the next reload, after which their handles are kept. `document.documentElement.dataset.folders` says which mode is on: `remembered` or `session`.
- **Host folders:** with a local proxy that exports folders (`npx @ai-ecoverse/slicc-node --mount <path>[:<name>][:ro]`, or slicc-swift), `mount -t hostfs <name> /mnt/h` mounts one with no picker. The page asks the proxy for a token scoped to that folder (`POST /api/hostfs/grant` with the proxy key); the kernel gets only the token, and neither the key nor the token shows up in `/proc/mounts`. A name the proxy doesn't export (`POST /api/hostfs/mounts`) is refused at once (exit 32, permission denied), and without a proxy `mount` refuses with `hostfs is not available here (no host connection)` (exit 32).
- **Deleted but open files:** the kernel keeps a file that a program still has open after it's deleted in `.slicc-unlinked/` at the mount's root until it's closed (slicc-kernel ≥ 1.37.1). In a mounted folder that directory is visible on the host, so a repository there may want it in `.gitignore`.
- **No modes or symlinks** in an `fsa` folder: the File System Access API has neither, so `chmod` there succeeds and changes nothing (`stat` keeps `644`), and symlinks can't be made there.
- **The tree** lists mounted folders through the kernel (spectrum's file port reads only OPFS), skipping `node_modules` and `.git` and stopping at 5,000 entries. It follows changes made through the kernel at once and others every 10 s. Reads, writes and removals below a mount point go through the kernel too.

### Agent

[slicc-agent](https://github.com/ai-ecoverse/slicc-agent) and its dependencies (about 100 packages, most of them provider SDKs) aren't part of the first boot either. They are a separate pnpm project, [`src/packages/agent/`](src/packages/agent/), installed like the grammars, so the BIOS boots as fast as without an agent. slicc-agent takes `@ai-ecoverse/slicc-kernel` as a peer, so the project pins the same kernel as the base set, and a test keeps the two pins equal. Its `pnpm-workspace.yaml` overrides `@google/genai` and `esbuild` to nothing (`'-'`): a Bedrock turn never loads them, and dropping them and their trees takes `/opt/agent` from 99 packages to 58. Seven's pnpm reads overrides only from the workspace file, so the installer copies it into `/opt/agent` next to the lockfile:

1. **After every update check,** `os/agent.js` compares the deployed `packages/agent/pnpm-lock.yaml` with `var/lib/slicc/agent/pnpm-lock.yaml`. If they differ, it writes the manifest and lockfile to `/opt/agent` and runs `pnpm install --frozen-lockfile --trust-lockfile` there under its own Web Lock, `slicc-agent-install`. The **Agent** row of [Install / Update](#install--update) shows pnpm's progress: *Downloading n of m* while pnpm fetches packages (reused from its store or downloaded), then *Linking n of m* once it starts adding them, because pnpm adds nothing until the fetching is done. Only once pnpm succeeds does it record the lockfile. A failed install shows the error, pnpm's log and **Retry**, and the next check tries again.
2. **Once it's installed,** the page imports `page.js` and `spectrum/index.js` from `/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/`. `startAgent` takes the Web Lock `slicc-agent`, starts `agent-worker.js` from there as a module worker and hands it a port to the page's kernel, so the agent's `bash`, `read`, `write` and `edit` run on the same kernel and files as the terminal. The page swaps in `createAgentModel()` when the worker connects. On later loads the agent starts at once, before any network check, so chat works offline. If another tab owns the agent, this tab has terminals and files only.
3. **The conversation** is kept in SQLite in OPFS (`/.slicc/agent/`).

`/opt/agent` is an ordinary pnpm project, so `cd /opt/agent && pnpm upgrade` updates the agent in place, and the service worker drops its resolution cache when `/opt/agent`'s lockfile or `.modules.yaml` changes. When an update installs a new `/opt/agent` while the agent runs, the **Agent** row says *Ready to apply* and offers **Restart agent** (D16). It waits until the agent is idle, then restarts only the agent worker; durable resumes the conversation from SQLite, and the page reconnects and swaps in the new connection. The kernel, terminals and the page itself keep running, so the page-side adapter is updated at the next reload.

### Grammars

Spectrum bundles 16 syntax languages; the rest come from `@shikijs/langs` and `@shikijs/themes` (725 and 135 files). They aren't part of the first boot. They're a separate pnpm project, [`src/packages/grammars/`](src/packages/grammars/), deployed next to the BIOS's lockfiles:

1. **Until they're installed,** the UI loads grammars from jsDelivr.
2. **After every update check,** `os/grammars.js` compares the deployed `packages/grammars/pnpm-lock.yaml` with `var/lib/slicc/grammars/pnpm-lock.yaml`. If they differ, it writes the manifest and lockfile to `/opt/grammars` and runs `pnpm install --frozen-lockfile --trust-lockfile` there, under its own Web Lock, `slicc-grammars`, so a long install never holds up the BIOS in another tab. Only once pnpm succeeds does it record the lockfile.
3. **Once they're installed,** `grammarBase` points at `/opt/grammars/node_modules/@shikijs/`. On later loads the page sets it as soon as the recorded lockfile is there, before any network check, so highlighting works offline. If pnpm fails, the page stays on jsDelivr, the **Syntax grammars** row shows the error with **Retry**, and the next check tries again.

The Files panel lists `/opt/grammars/node_modules` but doesn't scan it.

### Install / Update

`os/updates.js` is spectrum's `UpdatesPort` (`model.updates`, spectrum ≥ 1.27.0), with one row per component: **Agent** (`/opt/agent`), **Kernel** (`slicc-kernel`), **UI** (`slicc-spectrum`), **BIOS packages** (the other root packages) and **Syntax grammars**. Each row shows its version, when it was last checked, pnpm's download or link count while it installs, and pnpm's output under *Install log*. A component that isn't installed yet is *Waiting* (`queued`, spectrum ≥ 1.29.0) until its install starts. A failed row leads with one sentence on what failed and what to do, and keeps pnpm's output in the log. `ready()` is false at every boot until the agent's model is in place, or until the check finds no agent to start. While it is false, spectrum opens the Install / Update panel, so it shows while the agent installs or loads; while an installed agent starts, its row reads *Starting* (`starting`, spectrum ≥ 1.37.0). It closes once the agent is up without failures, and a new failure opens it again. An installed agent that doesn't start fails its row with **Retry**. Background updates show in the header. Each row's actions go back to the installers: **Retry** runs that installer again, **Restart agent** restarts the agent worker and **Reload** reloads through the BIOS.


## Modules

Packages are served unbundled, exactly as npm publishes them, so `pnpm upgrade <package>` updates one of them in place. Browsers refuse bare specifiers, and an import map would only cover documents, so the service worker rewrites the imports of every script it serves from OPFS, for pages and workers alike:

- **Scanning:** `src/sw/scan.js` finds static imports, re-exports and dynamic imports of string literals while skipping comments, strings, templates and regular expressions. On the 21,000 scripts of slicc-agent's and slicc-spectrum's dependencies it finds exactly what es-module-lexer finds.
- **Resolving** (`src/sw/resolve.js`): bare specifiers resolve like Node does for a browser bundler, by walking up to the nearest `node_modules/<name>`.
  - `exports` is read with the conditions `browser`, `import`, `module` and `default`, then the `browser` field (including its file mappings), `module` and `main`.
  - Extensionless relative imports get `.js`, `.mjs`, `.cjs`, `.json` or `/index.js`.
- **Node built-ins** (`node:x` and the bare names) become `/__slicc/node/<x>.js`. That's a generated module exporting exactly the names the importer asks for: `crypto.randomUUID`, `getRandomValues`, `webcrypto` and `subtle` are real, and everything else throws when called (not when imported). `node:worker_threads` is a real module instead: its `Worker` starts a module Web Worker, posts `workerData` to it first, and forwards `message` and `error`; inside that worker, `workerData` and a `parentPort` with `postMessage` and `on('message')` work as in Node.
- **CommonJS** (`src/sw/transform.js`): a script without module syntax that uses `require` or `exports` is wrapped as an ES module. Its `require()` calls become imports, `module.exports` is the default export, and `exports.x =` assignments become named exports.
- **Caching:** rewritten scripts are cached per file until the file or `/pnpm-lock.yaml` changes, so an update is picked up without reinstalling the service worker.

## Network

Before the kernel starts, `os/transport.js` picks how programs reach the network. The first of these that applies wins:

1. **A local proxy:** [slicc-node](https://github.com/ai-ecoverse/slicc-node) (`npx @ai-ecoverse/slicc-node`) or slicc-swift. The launcher opens `https://seven.sliccy.ai/#proxy=<url>&key=<key>`. The page takes both from the fragment and removes them from the address bar. It accepts only a plain `http://` origin on `127.0.0.1`, `localhost` or `[::1]`, so a link can't send traffic elsewhere. It keeps them in IndexedDB (`slicc-os`, store `transport`), so a reload keeps using the proxy. Each load checks the proxy with `checkLocalProxy`. If the proxy refuses the key (every proxy process mints a new one), isn't a proxy, or doesn't answer although the page may reach loopback, the page forgets it and falls through. It keeps the proxy, and still falls through, when Chrome's Local Network Access permission is denied, or when nothing answered while the permission is undecided (Chrome asks only once it has a connection, so a dismissed prompt and a stopped proxy look the same).
2. **[slicc-extension](https://github.com/ai-ecoverse/slicc-extension):** when the extension defines `globalThis.sliccExtension`, the kernel uses `fetchTransport({ fetch: sliccExtension.fetch })`.
3. **The page's own `fetch`:** `fetchTransport()`, bound by CORS. A request CORS stops is answered `502` with a hint to run slicc-node or install slicc-extension, which `curl` prints.

The choice is in `document.documentElement.dataset.transport`: `local-proxy`, `extension` or `page`. `os/network.js` is spectrum's `NetworkPort` (`model.network`, spectrum ≥ 1.32.0), behind the header's **Network** indicator and panel:

- **Route and health:** `proxy` or `extension` is green (`ok`) and turns red (`failing`) when its last request failed, until one gets through. `page` is yellow (`limited`).
- **Detail:** one line, next to spectrum's own description of the route. It names the local proxy. When a local proxy was asked for but isn't used, it says why (blocked by the permission, not answering, or refusing the key) and what the page uses instead. When the route stops answering, it says so and what to do. It is empty on the extension and the page fetch while there is nothing to add.
- **Failures:** the last 20 requests that failed in the transport, newest first, with URL, error and time.
- **Check again** (`check()`) probes the local proxy again: on the proxy route it updates the health, and otherwise it reloads the page onto the proxy once it answers.
- **Get the whole web** links slicc-extension in the Chrome Web Store (`extensionUrl`).

## Browser automation

Programs in the kernel drive a browser over the Chrome DevTools Protocol: `playwright-cli` and `curlwright` ([slicc-cdp](https://github.com/ai-ecoverse/slicc-cdp), in the base set) or anything else that reads `SLICC_CDP_URL`. The kernel's facade on `127.0.0.1:9222` takes connections only from programs inside the kernel. It hands each one to the `cdp` hook that `os/cdp.js` gives `createKernel`, and the hook connects it to a host:

1. **[slicc-extension](https://github.com/ai-ecoverse/slicc-extension):** when the extension defines `sliccExtension.cdp`, its `chrome.debugger` bridge drives the Chrome that seven runs in. Every program connection shares the page's one extension port. The hook gives each connection only the answers to its own commands and the events of the sessions it attached, and on close it detaches every session the connection attached.
2. **The local proxy:** used when it is the transport (see [Network](#network)) and its probe says `cdp: 1`. The hook opens `ws://<proxy>/cdp` and offers the subprotocols `slicc.cdp.v1` and `slicc.key.<key>`, so the key never appears in a URL. It accepts the socket only when the proxy selects `slicc.cdp.v1`. The proxy checks the key and the page's `Origin` before the upgrade. slicc-node and slicc-swift keep one page client per `/cdp`, so every program connection shares one socket: the hook gives each command an id of its own, answers each connection with its own ids, and routes events by the sessions it attached (browser-level events go to every connection). When the last connection closes, so does the socket. When the proxy hands the socket to another page (`4001`) or loses its browser (`4002`), or closes it otherwise, every open connection is closed with a message saying which, and the next one opens a new socket.

A program picks a host by adding `runtime=extension` or `runtime=proxy` to the query of the URL it opens (`playwright-cli --runtime proxy`). With no runtime, the extension goes first. The hook never derives a URL from the request: it reaches only the extension's page global and the proxy the page already checked.

**Consent.** The first time a program asks for a connection in a page session, after the hook has found a host, seven asks with spectrum's `confirm()`: "Let SLICC’s agents control this browser?" (accent, **Allow** or **Don’t allow**, which keeps the focus). Allowing covers every later connection until the page reloads. Declining makes every connection in that session answer `502` `CDP host: browser control was declined in seven; reload to be asked again`. This interim gate is to be replaced by per-action approvals. The Network panel shows the host in its browser automation line (`browser` on the network port, from `browserVia`): through the extension, through slicc-node, or not available. After a decline it says browser automation is off for the session (`declined: true`) until a reload asks again.

When no host can drive a browser, `/json/list` and the WebSocket handshake answer `502` with `CDP host: no browser to drive: install slicc-extension, or run npx @ai-ecoverse/slicc-node`. A runtime that isn't `extension` or `proxy` gets `CDP host: unknown runtime "<name>" (extension, proxy)`. `/json/version` answers either way, since a hook is always offered.

### Tailscale (proof of concept)

seven can also join a tailnet, with a patched build of Tailscale's wasm client ([`@tailscale/connect`](https://www.npmjs.com/package/@tailscale/connect)) that adds a full HTTP `fetch`, raw `dial` (TCP and UDP, available to the page as `sliccTailscale.dial`), exit-node selection and status. It runs in its own module worker, `os/tailscale-worker.js`. No CORS applies, because Go makes the requests itself over the tailnet, and its relays (DERP) carry the traffic over WebSocket.

- **Turning it on:** the Network panel's **Use Tailscale** switch (spectrum ≥ 1.38.0) starts it at once and remembers the choice. Opening seven with `#tailscale=on` or `#tailscale=off` does the same. The setting, the exit node and the node's state are kept in IndexedDB (`slicc-os`, store `transport`), so the node keeps its identity across reloads.
- **The Network panel** (`os/network.js` passes `os/tailscale.js`'s panel through as `NetworkStatus.tailnet` and the port's `setTailnet`, `setExitNode`, `submitAuthKey` and `logoutTailnet`) shows:
  - the node's name and 100.x address and how many other devices are on the tailnet;
  - the exit node picker: None, Automatic (`auto:any`, the default), or one of the tailnet's exit nodes;
  - whether shields are up;
  - **Sign out**;
  - when it fails, why, with Retry (`check()` starts it again).

  `document.documentElement.dataset.tailscale` shows the backend state, or `off`.
- **Joining:** **Sign in to Tailscale** opens Tailscale's login in a new tab. Or paste an auth key into the panel's field. A key is held in memory for that one login and is never stored, put in a URL or logged. An auth key in the fragment is dropped with a warning. The integration test hands its key to the page in `globalThis.sliccTailscaleAuthKey` through an init script, and the page takes it once and deletes it. The tailnet object is exposed as `globalThis.sliccTailscale` only when an init script sets `globalThis.sliccTailscaleDebug`, as the integration test does.
- **Nothing inbound:** the node runs with shields up, so tailnet peers can't open connections to it. The build has no peerapi server, and the page listens on nothing. Peers can't reach the kernel's services, `*.kernel.localhost` or the CDP facade.
- **Where the wasm comes from:** [`@ai-ecoverse/wasm-tailscale`](https://www.npmjs.com/package/@ai-ecoverse/wasm-tailscale) (built in [ai-ecoverse/wasm-tailscale](https://github.com/ai-ecoverse/wasm-tailscale), certified) is a pnpm project of its own, [`src/packages/tailscale/`](src/packages/tailscale/), installed like the grammars, never at boot. The first time Tailscale is turned on, `os/tailscale.js` writes the deployed manifest and lockfile to `/opt/tailscale` and runs `pnpm install --frozen-lockfile --trust-lockfile` there under the Web Lock `slicc-tailscale`. The panel shows the download progress. The lockfile is recorded in `var/lib/slicc/tailscale/pnpm-lock.yaml`, so later starts skip the install, and a new deployed lockfile installs the new version on the next start. The page then reads `main.wasm` and `wasm_exec.js` through the kernel. A host folder mounted at `/mnt/tailscale` (`npx @ai-ecoverse/slicc-node --mount <dist>:tailscale:ro`, then `mount -t hostfs tailscale /mnt/tailscale`) wins over the package, for trying a local build.
- **Routing:** the kernel keeps the transport [picked above](#network), and Tailscale is layered over it. While an exit node is in use, every request goes through the tailnet, except loopback (which keeps `host.slicc.internal` on the local proxy). Without one, only tailnet addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) and MagicDNS names go there. 

## Kernel servers

A server running inside the kernel (vite, `python -m http.server`, impeccable `live`) listens on the kernel's own loopback, not the machine's. Pages reach it as **`http://<port>.kernel.localhost/`**:

- **Plain `localhost` and `127.0.0.1` stay the real machine.** The service worker passes them through untouched. Inside the kernel it's the other way round: `localhost` is the kernel loopback, and `host.slicc.internal` reaches the machine. The kernel exports the page-visible name as `SLICC_PAGE_LOOPBACK`, so tools can print the right URL.
- **Why the port goes in the name.** `kernel.localhost:8400` would resolve to the machine's real port 8400 whenever the service worker doesn't answer, as for a navigation or a WebSocket, and reach the wrong server. `8400.kernel.localhost` lands on port 80, which is closed or answered by [slicc-node](https://github.com/ai-ecoverse/slicc-node)'s kernel tunnel, and it gives every kernel port its own origin. The service worker routes by the name alone and ignores the URL's port.
- **How a request gets there.** A seven page's request to `*.kernel.localhost`, with any method, reaches the service worker. `*.localhost` is potentially trustworthy, so an `https` page loads it without a mixed-content block. The service worker answers it itself, so nothing goes to the network, no Local Network Access prompt is shown, and there's no CORS preflight. It hands the request to the `/os/` tab: the requesting one, or else the most recently focused. That tab calls `kernel.loopbackFetch(request, { port })` and transfers the streamed response body back.
- **The response.** Status, headers and body pass through. Bodies stream, so `EventSource` and long-poll work, and closing the `EventSource` closes the kernel socket. seven's pages are cross-origin isolated, so where the server sent none, the service worker adds `access-control-allow-origin: <seven's origin>` with `access-control-allow-credentials: true`, and `cross-origin-resource-policy: cross-origin`. That lets a plain `<script src>` or `fetch` load from a server that knows nothing about CORS.
- **When it fails.**
  - Nothing listens on the port: `502` `sw: nothing listening on kernel port <port>`.
  - No `/os/` tab is open: `502` `sw: no kernel to reach <port>.kernel.localhost`.
  - Any other kernel error: `502` that names the port.
  - The headers take longer than 30 s: `504` `sw: no answer from kernel port <port> for <path> in 30 s`.
  - After the headers, the 30 s applies to each chunk, not to the whole response. A stream that stays silent for 30 s is ended and its socket closed. `EventSource` reconnects by itself, so a server should send a comment line as a heartbeat. Chrome may also stop the service worker during a long stream, and `EventSource` reconnects then too.

What doesn't work through the service worker:

- **WebSockets.** A service worker never sees them, so `ws://<port>.kernel.localhost/` goes to the machine's port 80. Vite's HMR can't connect: the page loads and runs, but needs reloading by hand.
- **Opening a kernel server as a page.** A navigation to `http://<port>.kernel.localhost/` is another origin, which seven's service worker doesn't control.
- **Cookies.** The responses are built in the page, so `Set-Cookie` is dropped.

**slicc-node's kernel tunnel** carries what the service worker can't. slicc-node listens on `127.0.0.1:80`, or on the port `--kernel-port` gives it, and the URLs then carry that port: `http://8400.kernel.localhost:8080/`. It hands every connection to `*.kernel.localhost` to the page through a WebSocket, as raw bytes, so navigations, keep-alive and WebSocket upgrades (vite HMR) work. A page opened this way is its own origin, isolated from seven's.

- **Opening the tunnel.** When the local proxy's probe reports `kernelTunnel`, `os/tunnel.js` opens `ws://<proxy>/api/kernel-tunnel`, with the proxy key as a WebSocket subprotocol.
- **Serving streams.** For every stream slicc-node opens, the page calls `kernel.dial({ port })` and pipes the bytes both ways. Each direction may have at most 256 KiB in flight before the other side credits it, so a slow stream doesn't hold up the others.
- **A dial that fails** is reset with its error code. slicc-node then answers `502 nothing listening on kernel port <port>`.
- **Reconnecting.** A dropped tunnel reconnects after 1, 2, 5, 10, then every 30 seconds.
- **Several tabs.** slicc-node gives new streams to the most recently connected tunnel. A seven tab reconnects when it gets focus. When another seven tab's tunnel opens, for example after slicc-node restarts, a tab that has focus reconnects too, over the BroadcastChannel `slicc-kernel-tunnel`. So the focused tab's kernel takes new streams, and an old tunnel closes once its open streams have ended.

The contract is in slicc-node's README, under [Kernel services](https://github.com/ai-ecoverse/slicc-node#kernel-services).

## Updates

A running install updates itself from the deployment it was booted from, package by package, without a reload:

1. **Notice.** `os/update.js` fetches `packages/pnpm-lock.yaml` from the deployment when the UI starts, whenever the tab becomes visible again, and every 15 minutes. If it differs from `var/lib/slicc/pnpm-lock.yaml` in OPFS, there is an update.
2. **Install.** It writes the deployment's `package.json` and `pnpm-lock.yaml` to the OPFS root and runs `pnpm install --frozen-lockfile --trust-lockfile` there in the page's kernel. [`@ai-ecoverse/wasi-pnpm`](https://www.npmjs.com/package/@ai-ecoverse/wasi-pnpm) is one of the bootstrap packages, so pnpm is always installed. pnpm's hoisted, copying layout keeps `node_modules/` exactly where the BIOS puts it, and it only rewrites packages whose locked version changed. Its store lives in OPFS under `/home/.local/share/pnpm/`. Only when pnpm succeeds does the updater write the lockfile to `var/lib/slicc/pnpm-lock.yaml`, so an update that fails or is cut short by closing the tab is tried again by the next check.
3. **Switch over.** Packages are updated in place. A program reads its wasm and glue when it starts, so running processes, the interactive `bash` included, keep the code they started with, and every process started afterwards gets the new version. The page itself keeps the kernel and terminals it loaded. The changed rows of [Install / Update](#install--update) say *Ready to apply*, list what changed and offer **Reload**, which navigates to the BIOS with a view transition. The BIOS then picks up a new `sw.js` and seed, finds every package current (its receipt, or pnpm's `.modules.yaml` and the installed version, match), and goes back to `os/`. Files in OPFS, `/home` included, are not touched.

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
- `artifacts/<suite>/<test>/` – a screenshot of each tab at the end of the test, a `console.log` of every page and worker, and the minidump of any renderer or browser crash.
- `artifacts/hotspots.md` – added to the CI job summary. It says that profiling is off unless you turned it on.

CPU profiling is off by default, in CI too: V8's sampler interrupts every page and worker thread every 100 µs with a signal, and that is where the renderer crashes in [#114](https://github.com/ai-ecoverse/slicc-bios/issues/114) faulted. Run `SLICC_PROFILE=1 npm test` to get a `.cpuprofile` per page and worker for every document and test, the kernel's workers included (open them in the DevTools Performance panel or [speedscope](https://www.speedscope.app)). `hotspots.md` then lists the functions in `src/` with the most self time across all profiles. The profiles are recorded with coverage switched on, so absolute timings run high. Use them to compare functions with each other rather than as real-world numbers.

No test calls a real model. Every test serves an empty `packages/agent/` project (`emptyAgent` in `test/integration/chrome.mjs`), so only the chat test installs the agent in the background. In it, `test/integration/fake-proxy.mjs` plays a local proxy and answers Bedrock's `converse-stream` with a scripted event stream, so the turn runs through the real agent worker, pi-ai's Bedrock client and the kernel's transport. The test also signs in to Adobe against a fake IMS (`--host-resolver-rules` maps `ims-na1.adobelogin.com` to a local HTTPS server) and the fake proxy's `oauth-state`/`oauth-result` endpoints, cancelling once first.

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
- **Integration tests run in CI.** `test/integration/` is committed and runs on every push and pull request; run it locally with `npm test`. Their coverage report, screenshots and crash dumps are uploaded as CI artifacts for inspection, not used as a gate.
