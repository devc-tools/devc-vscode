# devc-vscode

Two separate VS Code extensions, each in its own folder with its own `package.json`, lockfile,
build, tests and `.vscode/` launch configuration. They share nothing at build time; open the
folder you're working on in VS Code and press <kbd>F5</kbd>.

- [`devc-vscode/`](devc-vscode/README.md): dev containers and SSH hosts in VS Code (files,
  terminals, agents, devc web).
- [`herdr-vscode/`](herdr-vscode/README.md): herdr sessions, spaces, agents and panes in VS Code.

Plans for both live in [`.plans/`](.plans/PLAN.md).
