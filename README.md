# slicc-bios

A slim loader for [SLICC](https://github.com/ai-ecoverse/slicc), from the boot-process idea in [ai-ecoverse/slicc#3793](https://github.com/ai-ecoverse/slicc/issues/3793): load a small BIOS first, put everything else into OPFS, and serve the UI from there.

The page shows six boot steps as they run:

1. **Acquire OPFS** – open the origin private file system and ask for persistent storage.
2. **Create installer worker** – start `installer.js`, a shared worker that does all of the BIOS's OPFS writes and is shared by every tab.
3. **Install packages from npm into OPFS** – the installer reads [`src/packages/package-lock.json`](src/packages/package-lock.json), the lockfile the BIOS ships with. For every locked package it downloads the tarball from `registry.npmjs.org` and checks its `integrity`, then unpacks it with the built-in `DecompressionStream` and [`modern-tar`](https://github.com/ayuhito/modern-tar) into OPFS at its lockfile path (`node_modules/…`). It records a receipt in `var/lib/bios/`. Packages whose receipt matches the lockfile's integrity and whose files are still there are not downloaded again, so pinning a new version replaces just that package. Replacing a package keeps its nested `node_modules`, and packages the lockfile no longer lists are deleted along with their receipts.
4. **Add UI page to OPFS** – the installer copies `src/seed/` to `os/` in OPFS. This is a stand-in until the UI ships as a downloadable asset.
5. **Intercept same-origin requests** – `sw.js` answers any in-scope request whose path exists in OPFS and passes everything else to the network. Everything it serves from OPFS carries `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`, so the UI page and the workers it starts are cross-origin isolated.
6. **Serve UI from OPFS** – navigate to `os/` with a cross-document view transition. That page imports [`@ai-ecoverse/slicc-kernel`](https://github.com/ai-ecoverse/slicc-kernel) and [`@ai-ecoverse/slicc-spectrum`](https://github.com/ai-ecoverse/slicc-spectrum) from `node_modules/` in OPFS through an import map, starts the kernel on the OPFS root and runs `bash -i` in a `<slicc-terminal>`. Commands come from the installed packages (`wasm-bash` and `wasm-coreutils`), the shell starts in `/home`, and whatever it writes stays in OPFS across reloads.

## Develop

```sh
npm install
npm start
npm test
npm run lint
```

`npm start` serves `src/` on <http://127.0.0.1:8080/>. There is no build step. To change what the BIOS installs, edit `src/packages/package.json` and refresh the lockfile with `npm install --package-lock-only` in that directory; npm resolves the dependency tree, the BIOS only replays it. `npm install` also installs the [lefthook](https://lefthook.dev) pre-commit hook, which runs Biome, the no-comment check, the no-unit-tests-in-git guard, and the diff-coverage check described below.

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
