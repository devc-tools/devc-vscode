# devc-vscode

Two separate VS Code extensions, each in its own folder under `extensions/` with its own `package.json`, lockfile,
build, tests and `.vscode/` launch configuration. They share nothing at build time; open the
folder you're working on in VS Code and press <kbd>F5</kbd>.

- [`extensions/devc-vscode/`](extensions/devc-vscode/README.md): dev containers and SSH hosts in VS Code (files,
  terminals, agents, devc web).
- [`extensions/herdr-vscode/`](extensions/herdr-vscode/README.md): herdr sessions, spaces, agents and panes in VS Code.

Plans for both live in [`.plans/`](.plans/PLAN.md).
