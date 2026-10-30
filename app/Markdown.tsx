/** @jsxImportSource react */
// Message text as sanitized GitHub-flavored markdown: no raw HTML, no styles from the text, no
// remote images, links only through the app's policy, code highlighted from safe tokens.
import {
  DEFAULT_THEMES,
  type FileDiffMetadata,
  getSharedHighlighter,
  parsePatchFiles,
} from "@pierre/diffs";
import type { Element, ElementContent } from "hast";
import { memo, type ReactNode, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Bridge } from "./bridge";
import { isDiff, safeExternalURL } from "./chat";

const bridge = (): Bridge | undefined => globalThis.openDot;

// The default GitHub schema, plus the classes remark-math marks math with. KaTeX runs after the
// sanitizer, on math the text can't style.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
};

const katexOptions = {
  trust: false,
  strict: "ignore" as const,
  throwOnError: false,
  maxExpand: 500,
  maxSize: 20,
};

const textOf = (node: ElementContent | Element): string =>
  node.type === "text" ? node.value : "children" in node ? node.children.map(textOf).join("") : "";

const Copy = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      aria-label="Copy code"
      onClick={() => {
        void bridge()
          ?.copyText(text)
          .then((done) => {
            setCopied(done);
            setTimeout(() => setCopied(false), 1500);
          });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
};

interface Token {
  content: string;
  htmlStyle?: Record<string, string>;
}

const highlightLimit = 100_000;

/** Tokens from Pierre's highlighter with its JavaScript engine, or nothing for plain text. */
export const highlight = async (code: string, language: string) => {
  if (code.length > highlightLimit) return undefined;
  const highlighter = await getSharedHighlighter({
    themes: [DEFAULT_THEMES.light, DEFAULT_THEMES.dark],
    langs: [language],
    preferredHighlighter: "shiki-js",
  });
  return highlighter.codeToTokens(code, { lang: language, themes: DEFAULT_THEMES })
    .tokens as Token[][];
};

const CodeBlock = ({ language, code }: { language: string | undefined; code: string }) => {
  const [tokens, setTokens] = useState<Token[][]>();
  useEffect(() => {
    let live = true;
    setTokens(undefined);
    if (language)
      highlight(code, language)
        .then((lines) => live && setTokens(lines))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, language]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language ?? "text"}</span>
        <Copy text={code} />
      </div>
      <pre>
        <code>
          {tokens
            ? tokens.map((line, row) => (
                <span className="line" key={row}>
                  {line.map((token, index) => (
                    <span key={index} style={token.htmlStyle}>
                      {token.content}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
};

const strip = (line: string | undefined) => (line ?? "").replace(/\r?\n$/, "");

/** A unified diff as rows, from Pierre's parser; nothing it parses becomes markup. */
export const DiffBlock = ({ code }: { code: string }) => {
  let files: FileDiffMetadata[];
  try {
    files = parsePatchFiles(code, undefined, true).flatMap((patch) => patch.files);
  } catch {
    files = [];
  }
  if (!files.some((file) => file.hunks.length))
    return <CodeBlock language={undefined} code={code} />;
  const rows: ReactNode[] = [];
  for (const [fileIndex, file] of files.entries()) {
    rows.push(
      <div className="diff-file" key={`f${fileIndex}`}>
        {file.prevName && file.prevName !== file.name
          ? `${file.prevName} → ${file.name}`
          : file.name}
      </div>,
    );
    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const key = `${fileIndex}-${hunkIndex}`;
      rows.push(
        <div className="diff-row diff-hunk" key={`h${key}`}>
          {hunk.hunkSpecs?.trim()}
        </div>,
      );
      let oldLine = hunk.deletionStart;
      let newLine = hunk.additionStart;
      const row = (kind: "add" | "del" | "same", text: string, id: string) => (
        <div className={`diff-row diff-${kind}`} key={id}>
          <span className="diff-num">{kind === "add" ? "" : oldLine}</span>
          <span className="diff-num">{kind === "del" ? "" : newLine}</span>
          <span className="diff-sign">{kind === "add" ? "+" : kind === "del" ? "-" : " "}</span>
          <span className="diff-text">{text}</span>
        </div>
      );
      for (const [blockIndex, block] of hunk.hunkContent.entries()) {
        const id = `${key}-${blockIndex}`;
        if (block.type === "context") {
          for (let index = 0; index < block.lines; index++) {
            rows.push(
              row(
                "same",
                strip(file.additionLines[block.additionLineIndex + index]),
                `${id}-${index}`,
              ),
            );
            oldLine++;
            newLine++;
          }
          continue;
        }
        for (let index = 0; index < block.deletions; index++) {
          rows.push(
            row(
              "del",
              strip(file.deletionLines[block.deletionLineIndex + index]),
              `${id}-d${index}`,
            ),
          );
          oldLine++;
        }
        for (let index = 0; index < block.additions; index++) {
          rows.push(
            row(
              "add",
              strip(file.additionLines[block.additionLineIndex + index]),
              `${id}-a${index}`,
            ),
          );
          newLine++;
        }
      }
    }
  }
  return (
    <div className="code-block diff">
      <div className="code-head">
        <span>diff</span>
        <Copy text={code} />
      </div>
      <div className="diff-body">{rows}</div>
    </div>
  );
};

const components: Components = {
  a: ({ href, children }) => {
    const url = safeExternalURL(href);
    if (!url) return <span className="link-inert">{children}</span>;
    return (
      <a
        href={url}
        title={url}
        rel="noreferrer noopener"
        onClick={(event) => {
          event.preventDefault();
          void bridge()?.openLink(url);
        }}
      >
        {children}
      </a>
    );
  },
  // Remote images never load: the text gets a label instead.
  img: ({ alt }) => <span className="image-inert">[image{alt ? `: ${alt}` : ""}]</span>,
  pre: ({ node }) => {
    const code = node?.children.find(
      (child): child is Element => child.type === "element" && child.tagName === "code",
    );
    if (!code) return null;
    const classes = code.properties.className;
    const language = (Array.isArray(classes) ? classes : [])
      .map(String)
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length)
      .toLowerCase();
    const text = textOf(code).replace(/\n$/, "");
    return isDiff(language, text) ? (
      <DiffBlock code={text} />
    ) : (
      <CodeBlock language={language} code={text} />
    );
  },
};

/** One message's text. Raw HTML in it is dropped, never rendered. */
export const Markdown = memo(({ text }: { text: string }) => (
  <div className="markdown">
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
      rehypePlugins={[
        [rehypeSanitize, schema],
        [rehypeKatex, katexOptions],
      ]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  </div>
));
