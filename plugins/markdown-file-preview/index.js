const STYLE_ID = "example-markdown-file-preview-style";

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .external-markdown-preview {
      max-width: 920px;
      margin: 0 auto;
      font-size: 14px;
      line-height: 1.7;
    }

    .external-markdown-preview > :first-child {
      margin-top: 0;
    }

    .external-markdown-preview > :last-child {
      margin-bottom: 0;
    }

    .external-markdown-preview h1,
    .external-markdown-preview h2 {
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border-light);
    }

    .external-markdown-preview h1 {
      font-size: 28px;
    }

    .external-markdown-preview h2 {
      font-size: 22px;
    }

    .external-markdown-preview h3 {
      font-size: 18px;
    }

    .external-markdown-preview h4 {
      font-size: 16px;
    }

    .external-markdown-preview pre {
      padding: 16px;
      border-radius: 12px;
      border: 1px solid var(--border-light);
      background: var(--bg-secondary);
      overflow-x: auto;
    }

    .external-markdown-preview code {
      font-size: 13px;
    }

    .external-markdown-preview blockquote {
      background: var(--accent-light);
      border-radius: 0 var(--radius) var(--radius) 0;
      padding: 10px 14px;
    }

    .external-markdown-preview table {
      overflow: hidden;
      border-radius: 12px;
    }

    .external-markdown-preview thead th {
      background: var(--elevated-surface-soft);
    }

    .external-markdown-preview hr {
      margin: 20px 0;
    }
  `;
  document.head.appendChild(style);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function sanitizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed || /^(?:javascript|data|vbscript):/i.test(trimmed)) {
    return "#";
  }
  return trimmed;
}

function parseInline(text) {
  const placeholders = [];
  const tokenPattern = /\u0000(\d+)\u0000/g;
  const store = (html) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let output = escapeHtml(text);

  output = output.replace(/`([^`]+)`/g, (_match, code) =>
    store(`<code>${escapeHtml(code)}</code>`)
  );

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) =>
    store(
      `<a href="${escapeHtml(sanitizeUrl(href))}" target="_blank" rel="noreferrer">${label}</a>`
    )
  );

  output = output.replace(/~~([^~]+)~~/g, (_match, value) =>
    store(`<del>${value}</del>`)
  );
  output = output.replace(/\*\*([^*]+)\*\*/g, (_match, value) =>
    store(`<strong>${value}</strong>`)
  );
  output = output.replace(/__([^_]+)__/g, (_match, value) =>
    store(`<strong>${value}</strong>`)
  );
  output = output.replace(/\*([^*\n]+)\*/g, (_match, value) =>
    store(`<em>${value}</em>`)
  );
  output = output.replace(/_([^_\n]+)_/g, (_match, value) =>
    store(`<em>${value}</em>`)
  );

  let previous = "";
  while (output !== previous) {
    previous = output;
    output = output.replace(tokenPattern, (_match, index) => {
      return placeholders[Number(index)] || "";
    });
  }

  return output;
}

function isBlank(line) {
  return /^\s*$/.test(line);
}

function isHorizontalRule(line) {
  return /^\s{0,3}(?:([-*_])(?:\s*\1){2,})\s*$/.test(line);
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) {
    value = value.slice(1);
  }
  if (value.endsWith("|")) {
    value = value.slice(0, -1);
  }
  return value.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function canStartTable(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) {
    return false;
  }

  const headerCells = splitTableRow(lines[index]);
  return headerCells.length > 1 && isTableDivider(lines[index + 1]);
}

function renderTable(lines, startIndex) {
  const headerCells = splitTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes("|") && !isBlank(lines[index])) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const headerHtml = headerCells
    .map((cell) => `<th>${parseInline(cell)}</th>`)
    .join("");
  const bodyHtml = rows
    .map((row) => {
      const cells = headerCells
        .map((_, cellIndex) => `<td>${parseInline(row[cellIndex] || "")}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return {
    html: `<table><thead><tr>${headerHtml}</tr></thead>${
      bodyHtml ? `<tbody>${bodyHtml}</tbody>` : ""
    }</table>`,
    nextIndex: index,
  };
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^ {0,3}(```+|~~~+)\s*([\w-]+)?\s*$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const language = fenceMatch[2] || "";
      const marker = fence.charAt(0);
      const requiredLength = fence.length;
      const codeLines = [];

      index += 1;
      while (index < lines.length) {
        const current = lines[index].trim();
        const isClosingFence =
          current.length >= requiredLength &&
          current.split("").every((char) => char === marker);

        if (isClosingFence) {
          break;
        }

        codeLines.push(lines[index]);
        index += 1;
      }

      const languageClass = language
        ? ` class="language-${escapeHtml(language)}"`
        : "";
      blocks.push(
        `<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
      );
      index += 1;
      continue;
    }

    if (canStartTable(lines, index)) {
      const table = renderTable(lines, index);
      blocks.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${parseInline(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines = [];

      while (
        index < lines.length &&
        (/^\s{0,3}>\s?/.test(lines[index]) || isBlank(lines[index]))
      ) {
        quoteLines.push(
          isBlank(lines[index])
            ? ""
            : lines[index].replace(/^\s{0,3}>\s?/, "")
        );
        index += 1;
      }

      blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^\s*(?:([-+*])|(\d+\.))\s+(.+)$/);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const tag = ordered ? "ol" : "ul";
      const items = [];

      while (index < lines.length) {
        const currentMatch = lines[index].match(/^\s*(?:([-+*])|(\d+\.))\s+(.+)$/);
        if (!currentMatch || Boolean(currentMatch[2]) !== ordered) {
          break;
        }

        items.push(`<li>${parseInline(currentMatch[3])}</li>`);
        index += 1;
      }

      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;

    while (
      index < lines.length &&
      !isBlank(lines[index]) &&
      !/^ {0,3}(```+|~~~+)/.test(lines[index]) &&
      !/^ {0,3}(#{1,6})\s+/.test(lines[index]) &&
      !isHorizontalRule(lines[index]) &&
      !/^\s{0,3}>\s?/.test(lines[index]) &&
      !/^\s*(?:[-+*]|\d+\.)\s+/.test(lines[index]) &&
      !canStartTable(lines, index)
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    blocks.push(`<p>${parseInline(paragraphLines.join(" "))}</p>`);
  }

  return blocks.join("");
}

export default function activate(api) {
  api.editor.registerPreviewRenderer({
    id: "example.markdown-file-preview.renderer",
    priority: 100,
    defaultMode: "split",
    matches({ path, language }) {
      return language === "markdown" || /\.(md|markdown|mdx)$/i.test(path);
    },
    render({ React, content }) {
      ensureStyles();
      return React.createElement("div", {
        className: "file-preview-surface chat-markdown external-markdown-preview",
        dangerouslySetInnerHTML: {
          __html: renderMarkdown(content),
        },
      });
    },
  });
}
