# Example Markdown File Preview

This is a real external plugin example for the AI IDE plugin system.

It demonstrates:

- how to declare an external plugin in `plugin.json`
- how to register `editor.registerPreviewRenderer(...)`
- how to keep plugin-specific styles inside the plugin instead of the host app
- how to ship a zero-build plugin that can be copied and installed offline

## Files

- `plugin.json`
  - plugin metadata, permissions, and entry file
- `index.js`
  - registers the Markdown preview renderer
  - injects preview styles
  - contains a lightweight Markdown-to-HTML renderer

## Permissions

This plugin only requests:

- `editor.preview`

## Supported Markdown

The bundled parser supports common Markdown features without requiring a build step:

- headings
- paragraphs
- blockquotes
- unordered and ordered lists
- fenced code blocks
- horizontal rules
- tables
- inline code
- links
- bold / italic / strikethrough

If you want richer syntax support, you can replace the renderer in `index.js` with your own implementation or bundle third-party dependencies into the plugin entry.
