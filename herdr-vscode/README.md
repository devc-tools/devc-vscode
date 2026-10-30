# herdr-vscode

herdr sessions, spaces, agents and panes in VS Code, for people who already use
[herdr](https://herdr.dev). This is a scaffold: it contributes a **herdr** activity-bar
container with an empty **Sessions** view; the views and tabs come in later releases.

herdr-vscode lives in the devc-vscode repo but is a self-contained extension: its own
`package.json`, lockfile, `node_modules`, build and tests. Nothing is shared with devc-vscode at
build time, and both extensions can be installed side by side.

## Development

```sh
cd herdr-vscode
npm ci
npm run build      # tsc type-check (out/) + esbuild bundle (dist/extension.js)
npm run lint
npm test           # .npmrc sets ignore-scripts, so pretest does not run: build first
npm run package:dev   # build a .vsix and install it into `code`
```

From the repo root in VS Code, the **Run herdr-vscode** launch configuration builds it and opens
an Extension Development Host with it loaded.
