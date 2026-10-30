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

- [ ] 1. Record the baseline: root `npm test` pass/fail counts and `npx vsce ls` output, in this
      plan's Implementation notes
- [ ] 2. Root fences: `tsconfig.json` gains `"include": ["src"]`; `.vscodeignore` gains
      `herdr-vscode/**`
- [ ] 3. `herdr-vscode/` scaffold: `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`,
      `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `.vscodeignore`, `.vscode-test.mjs`,
      `src/extension.ts`, `src/test/extension.test.ts`, `resources/herdr.svg`, `README.md`,
      `CHANGELOG.md`, `LICENSE`
- [ ] 4. `.vscode/launch.json` and `.vscode/tasks.json`: a "Run herdr-vscode" launch config next to
      the existing one
- [ ] 5. Root `README.md`: a short "herdr-vscode" section pointing at `herdr-vscode/README.md`

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

- [ ] At the root: `npm run compile` and `npm test` give the step 1 baseline results (same
      passes; nothing newly failing)
- [ ] At the root: `npx vsce ls | grep -c herdr-vscode` prints `0`
- [ ] `cd herdr-vscode && npm ci && npm run build && npm test` passes; `dist/extension.js` exists
- [ ] `cd herdr-vscode && npx vsce package --no-dependencies -o /tmp/herdr.vsix`; `unzip -l
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

(Record the step 1 baseline here.)
