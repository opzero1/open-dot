import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { highlight, Markdown } from "../Markdown";

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
