import * as monaco from "monaco-editor";

const EMPTY_ELEMENTS = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "menuitem",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
];

const componentConf: monaco.languages.LanguageConfiguration = {
  wordPattern:
    /(-?\d*\.\d\w*)|([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
  comments: {
    blockComment: ["<!--", "-->"],
  },
  brackets: [
    ["<!--", "-->"],
    ["<", ">"],
    ["{", "}"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "<", close: ">" },
  ],
  onEnterRules: [
    {
      beforeText: new RegExp(
        `<(?!(?:${EMPTY_ELEMENTS.join("|")}))([_:\\w][_:\\w-.\\d]*)([^/>]*(?!/)>)[^<]*$`,
        "i"
      ),
      afterText: /^<\/([_:\w][_:\w-.\d]*)\s*>$/i,
      action: {
        indentAction: monaco.languages.IndentAction.IndentOutdent,
      },
    },
    {
      beforeText: new RegExp(
        `<(?!(?:${EMPTY_ELEMENTS.join("|")}))(\\w[\\w\\d]*)([^/>]*(?!/)>)[^<]*$`,
        "i"
      ),
      action: {
        indentAction: monaco.languages.IndentAction.Indent,
      },
    },
  ],
  folding: {
    markers: {
      start: new RegExp("^\\s*<!--\\s*#region\\b.*-->"),
      end: new RegExp("^\\s*<!--\\s*#endregion\\b.*-->"),
    },
  },
};

function createAttributeValueSwitchState(
  prefix: "script" | "style"
): monaco.languages.IMonarchLanguageRule[] {
  const fallback =
    prefix === "script" ? "text/javascript" : "text/css";

  return [
    [
      /"(?:ts|typescript|tsx)"/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.typescript`,
      },
    ],
    [
      /'(?:ts|typescript|tsx)'/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.typescript`,
      },
    ],
    [
      /"(?:js|javascript|jsx|module)"/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.javascript`,
      },
    ],
    [
      /'(?:js|javascript|jsx|module)'/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.javascript`,
      },
    ],
    [
      /"(?:scss|sass)"/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.scss`,
      },
    ],
    [
      /'(?:scss|sass)'/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.scss`,
      },
    ],
    [
      /"(?:less)"/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.less`,
      },
    ],
    [
      /'(?:less)'/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.less`,
      },
    ],
    [
      /"(?:css|postcss|pcss|styl|stylus)"/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.css`,
      },
    ],
    [
      /'(?:css|postcss|pcss|styl|stylus)'/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.css`,
      },
    ],
    [
      /"([^"]*)"/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.${fallback}`,
      },
    ],
    [
      /'([^']*)'/,
      {
        token: "attribute.value",
        switchTo: `@${prefix}WithCustomType.${fallback}`,
      },
    ],
    [
      />/,
      {
        token: "delimiter",
        next: `@${prefix}Embedded`,
        nextEmbedded: fallback,
      },
    ],
    [/[ \t\r\n]+/, ""],
    [new RegExp(`</${prefix}\\s*>`), { token: "@rematch", next: "@pop" }],
  ];
}

function createEmbeddedTagStates(
  prefix: "script" | "style"
): Record<string, monaco.languages.IMonarchLanguageRule[]> {
  const defaultEmbedded =
    prefix === "script" ? "text/javascript" : "text/css";

  return {
    [prefix]: [
      [/(type|lang)/, "attribute.name", `@${prefix}AfterAttr`],
      [/"([^"]*)"/, "attribute.value"],
      [/'([^']*)'/, "attribute.value"],
      [/[\w\-:]+/, "attribute.name"],
      [/=/, "delimiter"],
      [
        />/,
        {
          token: "delimiter",
          next: `@${prefix}Embedded`,
          nextEmbedded: defaultEmbedded,
        },
      ],
      [/[ \t\r\n]+/, ""],
      [
        new RegExp(`(<\\/)(?:${prefix})(\\s*)(>)`),
        ["delimiter", "tag", { token: "delimiter", next: "@pop" }],
      ],
    ],
    [`${prefix}AfterAttr`]: [
      [/=/, "delimiter", `@${prefix}AfterAttrEquals`],
      [
        />/,
        {
          token: "delimiter",
          next: `@${prefix}Embedded`,
          nextEmbedded: defaultEmbedded,
        },
      ],
      [/[ \t\r\n]+/, ""],
      [new RegExp(`</${prefix}\\s*>`), { token: "@rematch", next: "@pop" }],
    ],
    [`${prefix}AfterAttrEquals`]: createAttributeValueSwitchState(prefix),
    [`${prefix}WithCustomType`]: [
      [
        />/,
        {
          token: "delimiter",
          next: `@${prefix}Embedded.$S2`,
          nextEmbedded: "$S2",
        },
      ],
      [/"([^"]*)"/, "attribute.value"],
      [/'([^']*)'/, "attribute.value"],
      [/[\w\-:]+/, "attribute.name"],
      [/=/, "delimiter"],
      [/[ \t\r\n]+/, ""],
      [new RegExp(`</${prefix}\\s*>`), { token: "@rematch", next: "@pop" }],
    ],
    [`${prefix}Embedded`]: [
      [
        new RegExp(`</${prefix}`),
        { token: "@rematch", next: "@pop", nextEmbedded: "@pop" },
      ],
      [/./, ""],
    ],
  };
}

function createBaseComponentLanguage(
  tokenPostfix: string
): monaco.languages.IMonarchLanguage {
  const sharedTagStates: Record<
    string,
    monaco.languages.IMonarchLanguageRule[]
  > = {
    doctype: [
      [/[^>]+/, "metatag.content"],
      [/>/, "metatag", "@pop"],
    ],
    comment: [
      [/-->/, "comment", "@pop"],
      [/[^-]+/, "comment.content"],
      [/./, "comment.content"],
    ],
    otherTag: [
      [/\/?>/, "delimiter", "@pop"],
      [/"([^"]*)"/, "attribute.value"],
      [/'([^']*)'/, "attribute.value"],
      [/[\w\-:@]+/, "attribute.name"],
      [/=/, "delimiter"],
      [/[ \t\r\n]+/, ""],
    ],
  };

  return {
    defaultToken: "",
    tokenPostfix,
    ignoreCase: true,
    tokenizer: {
      root: [
        [/<!DOCTYPE/, "metatag", "@doctype"],
        [/<!--/, "comment", "@comment"],
        [/(<)((?:[\w\-]+:)?[\w\-]+)(\s*)(\/>)/, ["delimiter", "tag", "", "delimiter"]],
        [/(<)(script)/, ["delimiter", { token: "tag", next: "@script" }]],
        [/(<)(style)/, ["delimiter", { token: "tag", next: "@style" }]],
        [/(<)((?:[\w\-]+:)?[\w\-]+)/, ["delimiter", { token: "tag", next: "@otherTag" }]],
        [/(<\/)((?:[\w\-]+:)?[\w\-]+)/, ["delimiter", { token: "tag", next: "@otherTag" }]],
        [/</, "delimiter"],
        [/[^<{]+/, ""],
      ],
      ...sharedTagStates,
      ...createEmbeddedTagStates("script"),
      ...createEmbeddedTagStates("style"),
    },
  };
}

function createVueLanguage(): monaco.languages.IMonarchLanguage {
  const base = createBaseComponentLanguage(".vue");
  return {
    ...base,
    tokenizer: {
      ...base.tokenizer,
      root: [
        [/<!DOCTYPE/, "metatag", "@doctype"],
        [/<!--/, "comment", "@comment"],
        [/\{\{/, { token: "delimiter.bracket", next: "@vueExpression", nextEmbedded: "typescript" }],
        [/(<)((?:[\w\-]+:)?[\w\-]+)(\s*)(\/>)/, ["delimiter", "tag", "", "delimiter"]],
        [/(<)(script)/, ["delimiter", { token: "tag", next: "@script" }]],
        [/(<)(style)/, ["delimiter", { token: "tag", next: "@style" }]],
        [/(<)((?:[\w\-]+:)?[\w\-]+)/, ["delimiter", { token: "tag", next: "@otherTag" }]],
        [/(<\/)((?:[\w\-]+:)?[\w\-]+)/, ["delimiter", { token: "tag", next: "@otherTag" }]],
        [/</, "delimiter"],
        [/[^<{]+/, ""],
        [/[{]/, ""],
      ],
      vueExpression: [
        [/\}\}/, { token: "delimiter.bracket", next: "@pop", nextEmbedded: "@pop" }],
        [/./, ""],
      ],
    },
  };
}

function createSvelteLanguage(): monaco.languages.IMonarchLanguage {
  const base = createBaseComponentLanguage(".svelte");
  return {
    ...base,
    tokenizer: {
      ...base.tokenizer,
      root: [
        [/<!DOCTYPE/, "metatag", "@doctype"],
        [/<!--/, "comment", "@comment"],
        [/\{[#:@\/][^}]*\}/, "metatag"],
        [/\{/, { token: "delimiter.bracket", next: "@svelteExpression", nextEmbedded: "typescript" }],
        [/(<)((?:[\w\-]+:)?[\w\-]+)(\s*)(\/>)/, ["delimiter", "tag", "", "delimiter"]],
        [/(<)(script)/, ["delimiter", { token: "tag", next: "@script" }]],
        [/(<)(style)/, ["delimiter", { token: "tag", next: "@style" }]],
        [/(<)((?:[\w\-]+:)?[\w\-]+)/, ["delimiter", { token: "tag", next: "@otherTag" }]],
        [/(<\/)((?:[\w\-]+:)?[\w\-]+)/, ["delimiter", { token: "tag", next: "@otherTag" }]],
        [/</, "delimiter"],
        [/[^<{]+/, ""],
      ],
      svelteExpression: [
        [/\}/, { token: "delimiter.bracket", next: "@pop", nextEmbedded: "@pop" }],
        [/./, ""],
      ],
    },
  };
}

function createComponentConf(): monaco.languages.LanguageConfiguration {
  return {
    ...componentConf,
    autoClosingPairs: [...(componentConf.autoClosingPairs || [])],
    surroundingPairs: [...(componentConf.surroundingPairs || [])],
    brackets: [...(componentConf.brackets || [])],
    comments: componentConf.comments,
    folding: componentConf.folding,
    onEnterRules: [...(componentConf.onEnterRules || [])],
  };
}

function registerLanguage(
  id: "vue" | "svelte",
  aliases: string[],
  language: monaco.languages.IMonarchLanguage
): void {
  if (monaco.languages.getLanguages().some((entry) => entry.id === id)) {
    return;
  }

  monaco.languages.register({ id, aliases, extensions: [`.${id}`] });
  monaco.languages.setLanguageConfiguration(id, createComponentConf());
  monaco.languages.setMonarchTokensProvider(id, language);
}

export function registerComponentLanguages(): void {
  registerLanguage("vue", ["Vue", "vue"], createVueLanguage());
  registerLanguage("svelte", ["Svelte", "svelte"], createSvelteLanguage());
}
