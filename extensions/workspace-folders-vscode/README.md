# Workspace Folders

A VS Code Explorer view for switching which repos and Git worktrees are open as workspace folders.

1. Click **+** (**Pin Folder…**) and pick one or more folders. A repo is listed with its Git worktrees under it, and picking a worktree pins its main repo. Any other folder is pinned by itself.
2. Tick or untick a folder, a repo (its main folder) or any of its worktrees. Changed rows are marked *will open* or *will close*.
3. Click **✓** (**Apply**) to add and remove the folders, or **Discard Changes** to drop the ticks.

Source Control follows: a repo whose folder is removed is closed there, and a repo whose folder is added is opened. If a repo you opened hasn't appeared there after a few seconds, a warning offers **Reopen Closed Repositories** and **Reload Window**.

- The window's first folder is always listed first, pinned automatically: its repo when it is a repo or a worktree, else the folder itself. Its row says *workspace root* and has no checkbox, since it always stays in the workspace.
- Other pins belong to that first folder, so they survive a reload and a single-folder window becoming multi-root.
- **Unpin** (the **×** on a pin) only takes it off the list. Its folders stay.
- Worktrees added or removed outside VS Code show up on **Refresh** or when the view is shown again.
- Hide the view from the Explorer's `…` menu if you don't use it. A repo it closes stays closed in this workspace until it is opened again here or with **Git: Reopen Closed Repositories…**.
- A linked worktree is added under the name `project/folder`, such as `project/feature-a`; a repo's main folder keeps its own name. Each change is written to the `.code-workspace` file.

## Development

Self-contained like the other extensions in `extensions/`: its own `package.json`, lockfile, build and tests. Node 24 (see `.nvmrc`).

```sh
npm install
npm run compile
npx mocha --ui tdd out/test/*.test.js   # the suites need no VS Code
npm run package:dev                     # builds workspace-folders-vscode-dev.vsix and installs it with `code`
```

Open `extensions/workspace-folders-vscode/` as the folder in VS Code and press <kbd>F5</kbd> (**Run Extension**) to try it in an Extension Development Host.

`src/git.ts` and `src/features.ts` are trimmed copies of devc-vscode helpers, maintained separately.
