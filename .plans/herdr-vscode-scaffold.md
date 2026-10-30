# herdr-vscode: a second extension in this repo

Asked for on 2026-10-30: a second extension, **herdr-vscode** (herdr sessions, spaces, agents and
panes inside VS Code, for people who already use herdr), lives in this repo instead of a new
one. UX mockups: https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP.

No monorepo tooling: devc-vscode stays exactly where it is, at the repo root, and herdr-vscode is
a self-contained folder, `herdr-vscode/`, with its own `package.json`, lockfile, `node_modules`,
build and tests. You `cd herdr-vscode` to work on it. Nothing is shared at build time; code
herdr-vscode needs from devc-vscode is copied (see [herdr-sidebar](herdr-sidebar.md)).

This plan only scaffolds an empty herdr-vscode and keeps the root extension from picking it up.
Features come in herdr-sidebar and later plans.

## Checklist

- [x] 1. Record the baseline: root `npm test` pass/fail counts and `npx vsce ls` output, in this
      plan's Implementation notes
- [x] 2. Root fences: `tsconfig.json` gains `"include": ["src"]`; `.vscodeignore` gains
      `herdr-vscode/**`
- [x] 3. `herdr-vscode/` scaffold: `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`,
      `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `.vscodeignore`, `.vscode-test.mjs`,
      `src/extension.ts`, `src/test/extension.test.ts`, `resources/herdr.svg`, `README.md`,
      `CHANGELOG.md`, `LICENSE`
- [x] 4. `.vscode/launch.json` and `.vscode/tasks.json`: a "Run herdr-vscode" launch config next to
      the existing one
- [x] 5. Root `README.md`: a short "herdr-vscode" section pointing at `herdr-vscode/README.md`

## Contracts

### Root (devc-vscode) changes

Only these two; devc-vscode's sources, `package.json`, build and output are untouched.

- `tsconfig.json`: add `"include": ["src"]`. **Gotcha:** without an `include`, `tsc` compiles every
  `.ts` under the project directory, so `herdr-vscode/src/**` would be pulled into the root build
  and fail `rootDir: "src"`.
- `.vscodeignore`: add `herdr-vscode/**` so devc-vscode's `.vsix` never contains it.

The root `.gitignore` patterns (`out`, `dist`, `node_modules`, `.vscode-test/`, `*.vsix`) are
unanchored and already cover `herdr-vscode/`. The root `lint` script is `eslint src` and is
already scoped.

### herdr-vscode/package.json

- `"name": "herdr-vscode"`, `"displayName": "herdr"`,
  `"description": "herdr sessions, spaces, agents and panes in VS Code."`, `"version": "0.0.1"`,
  `engines`, `repository`, `categories` as devc-vscode's; no `publisher` (as devc-vscode).
- `"main": "./dist/extension.js"`, `"activationEvents": ["onView:herdr.sessions"]`.
- `contributes`:
  - `viewsContainers.activitybar`: `[{"id":"herdr","title":"herdr","icon":"resources/herdr.svg"}]`
  - `views.herdr`: `[{"id":"herdr.sessions","name":"Sessions"}]`
  - `viewsWelcome`: `[{"view":"herdr.sessions","contents":"herdr sessions will appear here."}]`
- devDependencies: the same packages and ranges as the root `package.json` (`typescript`,
  `eslint`, `typescript-eslint`, `@types/vscode`, `@types/node`, `@types/mocha`,
  `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce`) plus `esbuild` pinned to an exact
  version (no `^`) that `min-release-age=3` accepts. The root's `overrides` are copied too.
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

- `.npmrc`, `.nvmrc`: copies of the root's (`engine-strict=true`, `ignore-scripts=true`,
  `min-release-age=3`; Node `24.21.0`). esbuild installs its binary through optional
  dependencies, so `ignore-scripts=true` does not break it.
- `tsconfig.json`: the root's `compilerOptions` (module Node16, target ES2022, strict, `types`
  node + mocha, `rootDir: "src"`, `outDir: "out"`, `sourceMap`), `"include": ["src"]`.
- `esbuild.mjs`: entry `src/extension.ts` → `dist/extension.js`; `bundle: true`,
  `platform: "node"`, `format: "cjs"`, `target: "node20"`, `external: ["vscode"]`,
  `sourcemap: true`. (Bundling now so later plans can add the webview entry and runtime
  dependencies without changing packaging.)
- `eslint.config.mjs`, `.vscode-test.mjs` (`files: 'out/test/**/*.test.js'`): copies of the root's.
- `.vscodeignore`: `**`, then `!dist/**`, `!resources/**`, `!package.json`, `!README.md`,
  `!CHANGELOG.md`, `!LICENSE`, then `dist/**/*.map`.

### herdr-vscode sources

- `src/extension.ts`: `activate` creates output channel `herdr`, logs `herdr-vscode activated`, and
  registers an empty `TreeDataProvider` for `herdr.sessions`.
- `src/test/extension.test.ts`: the extension activates; `herdr.sessions` is registered.
- `resources/herdr.svg`: 24×24 monochrome `currentColor` stroke icon of a split window (a
  rectangle, a vertical divider, a horizontal divider in the right half), as in the mockups.

### Launch configs

`.vscode/launch.json`: keep "Run Extension" (rename it "Run devc-vscode"); add "Run herdr-vscode"
with `--extensionDevelopmentPath=${workspaceFolder}/herdr-vscode`, `outFiles`
`${workspaceFolder}/herdr-vscode/dist/**/*.js`, `preLaunchTask` `herdr-vscode: build`.
`.vscode/tasks.json`: add an npm task `build` with `"path": "herdr-vscode"` and label
`herdr-vscode: build`.

### Coexistence

Both extensions may be installed at once. herdr-vscode contributes nothing under `devc-vscode.*`
and devc-vscode nothing under `herdr.*`.

## Validation

- [x] At the root: `npm run compile` and `npm test` give the step 1 baseline results (same
      passes; nothing newly failing)
- [x] At the root: `npx vsce ls | grep -c herdr-vscode` prints `0`
- [x] `cd herdr-vscode && npm ci && npm run build && npm test` passes; `dist/extension.js` exists
- [x] `cd herdr-vscode && npx vsce package --no-dependencies -o /tmp/herdr.vsix`; `unzip -l
      /tmp/herdr.vsix` lists `extension/dist/extension.js` and `extension/resources/herdr.svg`
      and no `node_modules/`, `src/`, `out/` or `.map` entries
- [ ] `code --install-extension /tmp/herdr.vsix`: a herdr icon is in the activity bar; Sessions
      shows the welcome text; the `herdr` output channel shows `herdr-vscode activated`
- [ ] "Run devc-vscode" and "Run herdr-vscode" each start an Extension Development Host with
      that extension loaded

## Relevant Files

- `tsconfig.json` (add `include`)
- `.vscodeignore` (exclude `herdr-vscode/**`)
- `.vscode/launch.json`, `.vscode/tasks.json`
- `README.md` (root: herdr-vscode section)
- New, under `herdr-vscode/`: `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`,
  `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `.vscodeignore`, `.vscode-test.mjs`,
  `src/extension.ts`, `src/test/extension.test.ts`, `resources/herdr.svg`, `README.md`,
  `CHANGELOG.md`, `LICENSE`
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

### Deviations and gotchas

- `.vscodeignore` uses `!dist/**/*.js`, not `!dist/**`. vsce applies every `!` pattern after the
  ignore patterns regardless of order, so `!dist/**` re-included `dist/extension.js.map` despite
  the later `dist/**/*.map`. A later plan that ships non-JS files from `dist/` (a webview's CSS,
  fonts) must add its own `!dist/**/*.css`-style line.
- `.npmrc`'s `ignore-scripts=true` also stops npm running `pretest` (as the root README notes for
  devc-vscode), so `npm test` alone does not build or lint; run `npm run build && npm run lint`
  first. The `pretest` script is kept as the contract names it.
- `vscode-test` downloads its own VS Code into `herdr-vscode/.vscode-test/` (gitignored), separate
  from the root's.
