# Change Log

## [Unreleased]

- **Reload Remote File**: a refresh button on remote editors (title bar, tab menu, Command Palette) that re-reads the file from its container or host now, asking first if there are unsaved changes.

## 0.0.1

- The **Remote Files** Explorer view: running dev containers and the SSH hosts in `remoteFiles.sshHosts` as roots, browsed and edited over `docker exec` and plain `ssh`. New file / folder, rename, delete, copy path, drag-and-drop (move within a root, copy across roots or from the Explorer), **Add SSH Host…** from `~/.ssh/config`, and **Terminal Here**. Open remote editors reload when the file changes. Split out of devc-vscode's Sandboxes view, which is unchanged.
