# External Plugins Directory

Copy external plugins into this directory to install them offline.

This repository already ships one working example plugin here:

- `markdown-file-preview/`
  - External Markdown preview plugin
  - Loaded automatically by default
  - Can be copied and modified as a reference implementation
  - See `markdown-file-preview/README.md` for the development notes

Each plugin must be a folder with:

- `plugin.json`
- an ES module entry file such as `index.js`

Reference:

- `docs/plugins/README.md`
- `docs/plugins/example-plugin/`
