# herdr-vscode: a second extension in this repo

Asked for on 2026-10-30: a second extension, **herdr-vscode** (herdr sessions, spaces, agents and
panes inside VS Code, for people who already use herdr), lives in this repo instead of a new
one. UX mockups: https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP.

No monorepo tooling: each extension is a self-contained folder beside the other,
`devc-vscode/` and `herdr-vscode/`, with its own `package.json`, lockfile, `node_modules`, build,
tests and `.vscode/` launch configuration. You `cd` into (or open in VS Code) the one you work on.
Nothing is shared at build time; code herdr-vscode needs from devc-vscode is copied (see
[herdr-sidebar](herdr-sidebar.md)). The repo root holds only `.plans/`, `.gitignore`, `LICENSE`
and an index `README.md`.

This plan moves devc-vscode into `devc-vscode/` unchanged and scaffolds an empty herdr-vscode.
Features come in herdr-sidebar and later plans.

## Checklist

- [x] 1. Record the baseline: root `npm test` pass/fail counts and `npx vsce ls` output, in this
      plan's Implementation notes
- [x] 2. `git mv` every devc-vscode file from the root into `devc-vscode/` (contents unchanged;
      `LICENSE` copied so the root keeps one)
- [x] 3. `herdr-vscode/` scaffold: `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`,
      `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `.vscodeignore`, `.vscode-test.mjs`,
      `src/extension.ts`, `src/test/extension.test.ts`, `resources/herdr.svg`, `README.md`,
      `CHANGELOG.md`, `LICENSE`
- [x] 4. `herdr-vscode/.vscode/`: `launch.json` ("Run Extension"), `tasks.json` (default build
      task `npm run build`), `settings.json`, `extensions.json`
- [x] 5. Root `README.md`: a short index pointing at `devc-vscode/README.md` and
      `herdr-vscode/README.md`; `devc-vscode/README.md`'s Develop section starts with
      `cd devc-vscode`

## Contracts

### Repo layout

- `devc-vscode/`: everything that was at the root for devc-vscode (`src/`, `resources/`, `docs/`,
  `spike/`, `.vscode/`, `package.json`, lockfile, `tsconfig.json`, `.npmrc`, `.nvmrc`,
  `.prettierrc`, `.vscodeignore`, `.vscode-test.mjs`, `eslint.config.mjs`, `README.md`,
  `CHANGELOG.md`, `vsc-extension-quickstart.md`, `LICENSE`), moved with `git mv` and otherwise
  unchanged apart from the README's `cd devc-vscode` line. Its build, tests and `.vsix` contents
  are the same as before the move.
- `herdr-vscode/`: the new extension.
- Root: `.plans/`, `.gitignore`, `LICENSE`, `README.md` (index). The root `.gitignore` patterns
  (`out`, `dist`, `node_modules`, `.vscode-test/`, `*.vsix`) are unanchored and cover both
  folders.

### herdr-vscode/package.json

- `"name": "herdr-vscode"`, `"displayName": "herdr"`,
  `"description": "herdr sessions, spaces, agents and panes in VS Code."`, `"version": "0.0.1"`,
  `engines`, `repository`, `categories` as devc-vscode's; no `publisher` (as devc-vscode).
- `"main": "./dist/extension.js"`, `"activationEvents": ["onView:herdr.sessions"]`.
- `contributes`:
  - `viewsContainers.activitybar`: `[{"id":"herdr","title":"herdr","icon":"resources/herdr.svg"}]`
  - `views.herdr`: `[{"id":"herdr.sessions","name":"Sessions"}]`
  - `viewsWelcome`: `[{"view":"herdr.sessions","contents":"herdr sessions will appear here."}]`
- devDependencies: the same packages and ranges as devc-vscode's `package.json` (`typescript`,
  `eslint`, `typescript-eslint`, `@types/vscode`, `@types/node`, `@types/mocha`,
  `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce`) plus `esbuild` pinned to an exact
  version (no `^`) that `min-release-age=3` accepts. devc-vscode's `overrides` are copied too.
- Scripts:
  - `compile`: `tsc -p ./` (type-check; emits `out/` for tests)
  - `bundle`: `node esbuild.mjs`
  - `build`: `npm run compile && npm run bundle`
  - `watch`: `tsc -watch -p ./`
  - `lint`: `eslint src`
  - `pretest`: `npm run build && npm run lint`
  - `test`: `vscode-test`
  - `vscode:prepublish`: `npm run build`
  - `package:dev`: `vsce package --no-dependencies -o herdr-vscode-dev.vsix && code --install-extension herdr-vscode-dev.vsix`

### herdr-vscode build files

- `.npmrc`, `.nvmrc`: copies of devc-vscode's (`engine-strict=true`, `ignore-scripts=true`,
  `min-release-age=3`; Node `24.21.0`). esbuild installs its binary through optional
  dependencies, so `ignore-scripts=true` does not break it.
- `tsconfig.json`: devc-vscode's `compilerOptions` (module Node16, target ES2022, strict, `types`
  node + mocha, `rootDir: "src"`, `outDir: "out"`, `sourceMap`), `"include": ["src"]`.
- `esbuild.mjs`: entry `src/extension.ts` → `dist/extension.js`; `bundle: true`,
  `platform: "node"`, `format: "cjs"`, `target: "node20"`, `external: ["vscode"]`,
  `sourcemap: true`. (Bundling now so later plans can add the webview entry and runtime
  dependencies without changing packaging.)
- `eslint.config.mjs`, `.vscode-test.mjs` (`files: 'out/test/**/*.test.js'`): copies of devc-vscode's.
- `.vscodeignore`: `**`, then `!dist/**/*.js`, `!resources/**`, `!package.json`, `!README.md`,
  `!CHANGELOG.md`, `!LICENSE`, then `dist/**/*.map`.

### herdr-vscode sources

- `src/extension.ts`: `activate` creates output channel `herdr`, logs `herdr-vscode activated`, and
  registers an empty `TreeDataProvider` for `herdr.sessions`.
- `src/test/extension.test.ts`: the extension activates; `herdr.sessions` is registered.
- `resources/herdr.svg`: 24×24 monochrome `currentColor` stroke icon of a split window (a
  rectangle, a vertical divider, a horizontal divider in the right half), as in the mockups.

### Launch configs

Each extension has its own `.vscode/`; open its folder in VS Code and press F5.
`devc-vscode/.vscode/` is the old root one, unchanged. `herdr-vscode/.vscode/launch.json`: "Run
Extension" with `--extensionDevelopmentPath=${workspaceFolder}`, `outFiles`
`${workspaceFolder}/dist/**/*.js`, `preLaunchTask` `${defaultBuildTask}`;
`herdr-vscode/.vscode/tasks.json`: npm task `build`, the default build task.

### Coexistence

Both extensions may be installed at once. herdr-vscode contributes nothing under `devc-vscode.*`
and devc-vscode nothing under `herdr.*`.

## Validation

- [x] In `devc-vscode/`: `npm run compile` and `npm test` give the step 1 baseline results (same
      passes; nothing newly failing)
- [x] In `devc-vscode/`: `npx vsce ls` lists the same 32 entries as the step 1 baseline
- [x] The repo root holds only `.plans/`, `.gitignore`, `LICENSE`, `README.md`, `devc-vscode/`,
      `herdr-vscode/` (`git ls-tree --name-only HEAD`)
- [x] `cd herdr-vscode && npm ci && npm run build && npm test` passes; `dist/extension.js` exists
- [x] `cd herdr-vscode && npx vsce package --no-dependencies -o /tmp/herdr.vsix`; `unzip -l
      /tmp/herdr.vsix` lists `extension/dist/extension.js` and `extension/resources/herdr.svg`
      and no `node_modules/`, `src/`, `out/` or `.map` entries
- [ ] `code --install-extension /tmp/herdr.vsix`: a herdr icon is in the activity bar; Sessions
      shows the welcome text; the `herdr` output channel shows `herdr-vscode activated`
- [ ] Opening `devc-vscode/` and `herdr-vscode/` in VS Code, F5 ("Run Extension") in each starts
      an Extension Development Host with that extension loaded

## Relevant Files

- Every tracked devc-vscode file at the root, moved to `devc-vscode/` (see Repo layout)
- `devc-vscode/README.md` (Develop: `cd devc-vscode`)
- `README.md` (root: new index)
- New, under `herdr-vscode/`: `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`,
  `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `.vscodeignore`, `.vscode-test.mjs`,
  `.vscode/launch.json`, `.vscode/tasks.json`, `.vscode/settings.json`,
  `.vscode/extensions.json`, `src/extension.ts`, `src/test/extension.test.ts`,
  `resources/herdr.svg`, `README.md`, `CHANGELOG.md`, `LICENSE`
- `.plans/PLAN.md`

## Implementation notes

### Step 1 baseline (2026-10-30, before any change but the PLAN.md status)

- Environment: `npm test` launches VS Code 1.144.0 (linux-arm64) from `.vscode-test/`. In this
  container it first needed `libgtk-3` (installed with apt: `libgtk-3-0t64 libnss3 libgbm1
  libasound2t64 libxss1 libsecret-1-0`) and a display, so it was run as `xvfb-run -a npm test`.
  Without those it exits 127 (`libgtk-3.so.0: cannot open shared object file`).
- Root `npm test` (`pretest` compile + lint pass): **293 passing, 23 pending, 1 failing**, the
  failure being `DevcWebServer › gives up when no ready line comes in time`. That suite is
  timing-sensitive and flaky here: of three runs, two gave exactly this result and one gave 3
  failures, all in `DevcWebServer` (`waits while another window holds the start lock`,
  `takes over a lock left by a dead window`, `gives up when no ready line comes in time`).
- Root `npx vsce ls`: 32 entries — `.nvmrc`, `CHANGELOG.md`, `LICENSE`, `README.md`,
  `package.json`, 22 `out/*.js` files (no `out/test/`), `resources/devc-web.svg`, and 4
  `node_modules/@xterm/headless/` files. `npx vsce ls | grep -c herdr-vscode` prints `0`.

### After the change

- Root `npm run compile` and `eslint src` pass; `xvfb-run -a npm test`: **293 passing, 23 pending,
  1 failing** (`DevcWebServer › gives up when no ready line comes in time`), the baseline result.
- Root `npx vsce ls`: the same 32 entries as the baseline (only the listing order differs);
  `grep -c herdr-vscode` prints `0`.
- herdr-vscode: `npm ci`, `npm run build`, `npm run lint` pass; `xvfb-run -a npm test`: 2 passing;
  `dist/extension.js` exists; the `.vsix` holds `extension/dist/extension.js`,
  `extension/resources/herdr.svg`, `package.json`, `readme.md`, `changelog.md`, `LICENSE.txt`
  and nothing else.

### Layout change (2026-10-30, after the first commit)

The first commit kept devc-vscode at the root behind two fences (`tsconfig.json` `include`,
`.vscodeignore` `herdr-vscode/**`) and added "Run herdr-vscode" to the root `.vscode/`. On review
the layout became two dedicated folders instead: the fences and root launch/README edits were
reverted and devc-vscode moved into `devc-vscode/`. In `devc-vscode/` afterwards: compile and lint
pass, `npx vsce ls` lists the same 32 entries, `xvfb-run -a npm test` gives **294 passing, 23
pending, 0 failing** (the flaky `DevcWebServer` test passed this run). herdr-vscode: build, lint,
2 tests pass, `vsce ls` unchanged.

Plans written before the move (phases 5–9) name devc-vscode files as `src/...`; read those as
`devc-vscode/src/...`.

### Deviations and gotchas

- `.vscodeignore` uses `!dist/**/*.js`, not `!dist/**`. vsce applies every `!` pattern after the
  ignore patterns regardless of order, so `!dist/**` re-included `dist/extension.js.map` despite
  the later `dist/**/*.map`. A later plan that ships non-JS files from `dist/` (a webview's CSS,
  fonts) must add its own `!dist/**/*.css`-style line.
- `.npmrc`'s `ignore-scripts=true` also stops npm running `pretest` (as devc-vscode's README notes for
  devc-vscode), so `npm test` alone does not build or lint; run `npm run build && npm run lint`
  first. The `pretest` script is kept as the contract names it.
- `vscode-test` downloads its own VS Code into `herdr-vscode/.vscode-test/` (gitignored), separate
  from devc-vscode's.
