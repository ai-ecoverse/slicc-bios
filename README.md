# slicc-bios

A slim loader for [SLICC](https://github.com/ai-ecoverse/slicc), from the boot-process idea in [ai-ecoverse/slicc#3793](https://github.com/ai-ecoverse/slicc/issues/3793): load a small BIOS first, put everything else into OPFS, and serve the UI from there.

The page shows six boot steps as they run:

1. **Acquire OPFS** – open the origin private file system and ask for persistent storage.
2. **Create shared worker** – start `kernel.js`, which does all OPFS writes and is shared by every tab.
3. **Install packages from npm into OPFS** – the shared worker reads [`src/packages/package-lock.json`](src/packages/package-lock.json), the lockfile the BIOS ships with. For every locked package it downloads the tarball from `registry.npmjs.org` and checks its `integrity`, then unpacks it with the built-in `DecompressionStream` and [`modern-tar`](https://github.com/ayuhito/modern-tar) into OPFS at its lockfile path (`node_modules/…`). It records a receipt in `var/lib/bios/`. Packages whose receipt matches the lockfile's integrity and whose files are still there are not downloaded again, so pinning a new version replaces just that package.
4. **Add UI page to OPFS** – the shared worker copies `src/seed/` to `os/` in OPFS. This is a stand-in until the UI ships as a downloadable asset.
5. **Intercept same-origin requests** – `sw.js` answers any in-scope request whose path exists in OPFS and passes everything else to the network.
6. **Serve UI from OPFS** – navigate to `os/` with a cross-document view transition. That page lists OPFS through the shared worker and compiles the installed `bash.wasm` straight from OPFS.

## Develop

```sh
npm install
npm start
npm test
npm run lint
```

`npm start` serves `src/` on <http://127.0.0.1:8080/>. There is no build step. To change what the BIOS installs, edit `src/packages/package.json` and refresh the lockfile with `npm install --package-lock-only` in that directory; npm resolves the dependency tree, the BIOS only replays it. `npm install` also installs the [lefthook](https://lefthook.dev) pre-commit hook, which runs Biome, the no-comment check, the no-unit-tests-in-git guard, and the diff-coverage check described below.

`npm test` runs the integration tests with `node --test` against Chromium (fetched by `playwright-core`), driven directly over the DevTools protocol. Every run leaves behind:

- `coverage/` – V8 coverage of the page, the shared worker, and the service worker as `lcov.info` plus an HTML report.
- `artifacts/<suite>/<test>/` – a `.cpuprofile` per page and worker for every document and test (open them in the DevTools Performance panel or [speedscope](https://www.speedscope.app)) and a screenshot of each tab at the end of the test.
- `artifacts/hotspots.md` – the functions in `src/` with the most self time across all profiles, also printed after the test run and added to the CI job summary.

The profiles are recorded with coverage switched on, so absolute timings run high. Use them to compare functions with each other rather than as real-world numbers.

## Rules

- **No comments.** `npm run lint:comments` runs the [slicc no-comment checker](https://github.com/ai-ecoverse/slicc/tree/main/packages/dev-tools/no-comment) over the tree.
- **Unit tests stay out of git.** Write them in `test/unit/`, which is gitignored, and run them with `npm run test:unit`. `npm run lint:no-unit-tests` fails if a unit test gets committed anyway.
- **Changed code must be covered.** When a commit touches JavaScript in `src/`, lefthook runs the local unit tests with coverage and [`diff-cover`](https://github.com/Bachmann1234/diff_cover) requires every staged line to be executed. Files that no unit test loads count as 0%. This needs [uv](https://docs.astral.sh/uv/) for `uvx`.
- **Integration tests run in CI.** `test/integration/` is committed and runs on every push and pull request; run it locally with `npm test`. Their coverage report, CPU profiles, and screenshots are uploaded as CI artifacts for inspection, not used as a gate.
