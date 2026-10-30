import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePatchFiles } from "@pierre/diffs";
import { diffLanguage, fileIcon, highlight, Markdown } from "../Markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test("hostile markdown renders no raw HTML, scripts, styles, handlers or unsafe links", () => {
  const html = render(
    [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src=https://evil.example></iframe>",
      '<a href="javascript:alert(1)">raw</a>',
      '<span style="position:fixed">styled</span>',
      "[js](javascript:alert(1)) [data](data:text/html,hi) [file](file:///etc/passwd)",
      "[creds](https://user:pass@example.com) [ok](https://example.com/a?b=1) [mail](mailto:me@example.com)",
    ].join("\n\n"),
  );
  for (const banned of [
    "<script",
    "<iframe",
    "onerror",
    "<style",
    "style=",
    "javascript:",
    "data:",
    "file:",
    "user:pass",
  ])
    expect(html).not.toContain(banned);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  expect(hrefs).toEqual(["https://example.com/a?b=1", "mailto:me@example.com"]);
  // The refused links stay readable as plain text.
  expect(html).toContain('<span class="link-inert">js</span>');
});

test("remote images never load and become labels", () => {
  const html = render("![tracker](https://example.com/pixel.png)");
  expect(html).not.toContain("<img");
  expect(html).toContain("[image: tracker]");
});

test("GitHub-flavored markdown renders headings, lists, task lists, tables and quotes", () => {
  const html = render(
    "## Title\n\n- [x] done\n- [ ] next\n\n1. one\n\n> quoted\n\n| a | b |\n| - | - |\n| 1 | ~~2~~ |",
  );
  expect(html).toContain("<h2>Title</h2>");
  expect(html).toContain('<input type="checkbox" disabled="" checked=""/>');
  expect(html).toContain("<ol>");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("<table>");
  expect(html).toContain("<del>2</del>");
});

test("inline and block math render with KaTeX, without trusted commands", () => {
  const html = render(
    "Inline $x^2$ and\n\n$$\n\\frac{a}{b}\n$$\n\n$\\href{javascript:alert(1)}{click}$",
  );
  expect(html).toContain('class="katex"');
  expect(html).toContain("katex-display");
  // \href stays text: KaTeX's trust is off, so no link is made.
  expect(html).not.toContain("<a ");
  expect(html).not.toContain('href="javascript');
});

test("fenced code gets a copy button, and a unified diff renders as added and removed rows", () => {
  const code = render("```ts\nconst a = 1;\n```");
  expect(code).toContain('class="code-block"');
  expect(code).toContain('aria-label="Copy code"');
  expect(code).toContain("const a = 1;");
  const diff = render("```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n```");
  expect(diff).toContain('class="code-block diff"');
  expect(diff).toMatch(/diff-del">.*-.*old/);
  expect(diff).toMatch(/diff-add">.*\+.*new/);
  // A malformed diff still shows its text, as plain code.
  expect(render("```diff\nnot a diff\n```")).toContain("not a diff");
});

test("code is highlighted into tokens with light and dark colors, not HTML", async () => {
  const lines = await highlight("const answer: number = 42;", "typescript");
  expect(lines?.[0]?.map((token) => token.content).join("")).toBe("const answer: number = 42;");
  expect(lines?.[0]?.[0]?.htmlStyle).toMatchObject({
    color: expect.any(String),
    "--shiki-dark": expect.any(String),
  });
  expect(await highlight("x".repeat(200_000), "typescript")).toBeUndefined();
});

test("a single line break in a paragraph renders as a break", () => {
  const html = render("first line\nsecond line\n\nnext paragraph");
  expect(html).toContain("first line<br/>");
  expect(html).toContain("second line</p>");
  expect(html).toContain("<p>next paragraph</p>");
  // Code keeps its own lines.
  expect(render("```\na\nb\n```")).not.toContain("<br");
});

test("the five GitHub alerts render as callouts with nested markdown kept", () => {
  for (const [marker, title] of [
    ["NOTE", "Note"],
    ["TIP", "Tip"],
    ["IMPORTANT", "Important"],
    ["WARNING", "Warning"],
    ["CAUTION", "Caution"],
  ]) {
    const html = render(`> [!${marker}]\n> Use **bold** here\n> and here`);
    const kind = String(marker).toLowerCase();
    expect(html).toContain(`<blockquote class="markdown-alert markdown-alert-${kind}">`);
    expect(html).toContain(`<p class="markdown-alert-title">${title}</p>`);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain(`[!${marker}]`);
    // The break inside the alert body still renders.
    expect(html).toContain("here<br/>");
  }
  // Not alerts: an unknown kind, a marker not on its own first line, and a plain quote.
  expect(render("> [!NOTE]\n> **bold** first")).toContain("markdown-alert-note");
  for (const text of [
    "> [!DANGER]\n> x",
    "> [!NOTE] *x*",
    "> text [!NOTE]\n> x",
    "> [!NOTE] inline",
    "> quoted",
  ]) {
    const html = render(text);
    expect(html).not.toContain("markdown-alert");
    expect(html).toContain("<blockquote>");
  }
});

test("long code folds with an expand control, while Copy keeps the whole block", () => {
  const code = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  const html = render("```ts\n" + code + "\n```");
  expect(html).toContain('class="code-block folded"');
  expect(html).toContain("line 12");
  expect(html).not.toContain("line 13");
  expect(html).toMatch(
    /<button type="button" class="code-fold" aria-expanded="false"[^>]*>Expand \(18 more lines\)<\/button>/,
  );
  const short = render("```ts\n" + code.split("\n").slice(0, 24).join("\n") + "\n```");
  expect(short).not.toContain("code-fold");
  expect(short).toContain("line 24");
});

test("code blocks and diffs show a bundled file-type badge, with a generic fallback", () => {
  expect(render("```ts\nx\n```")).toContain(
    'class="file-icon" style="background:#3178c6" aria-hidden="true">TS<',
  );
  expect(render("```python\nx\n```")).toContain(">PY<");
  expect(render("```unknownlang\nx\n```")).toContain(">•<");
  expect(fileIcon(undefined)[0]).toBe("•");
  const diff = render("```diff\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -1 +1 @@\n-a\n+b\n```");
  expect(diff).toContain(">RS<");
});

test("a diff's lines are colored as its file's language, each side separately", async () => {
  const [file] = parsePatchFiles(
    "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+let b = 2;\n",
  ).flatMap((patch) => patch.files);
  expect(file && diffLanguage(file)).toBe("typescript");
  expect(diffLanguage({ name: "docs/README.md" })).toBe("markdown");
  expect(diffLanguage({ name: "data.unknown" })).toBe("text");
  const before = await highlight(file?.deletionLines.join("") ?? "", "typescript");
  const after = await highlight(file?.additionLines.join("") ?? "", "typescript");
  expect(before?.[0]?.map((token) => token.content).join("")).toBe("const a = 1;");
  expect(after?.[0]?.map((token) => token.content).join("")).toBe("let b = 2;");
  expect(after?.[0]?.[0]?.htmlStyle).toMatchObject({ color: expect.any(String) });
});
