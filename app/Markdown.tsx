/** @jsxImportSource react */
// Message text as sanitized GitHub-flavored markdown: no raw HTML, no styles from the text, no
// remote images, links only through the app's policy, code highlighted from safe tokens.
import {
  DEFAULT_THEMES,
  type FileDiffMetadata,
  getFiletypeFromFileName,
  getSharedHighlighter,
  parsePatchFiles,
} from "@pierre/diffs";
import type { Element, ElementContent } from "hast";
import type { Blockquote, Paragraph, Root, RootContent } from "mdast";
import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Bridge, Bytes, Result } from "./bridge";
import { isDiff, mediaKey, type MediaView, safeExternalURL } from "./chat";

const bridge = (): Bridge | undefined => globalThis.openDot;

/** The five GitHub alert kinds, each with its title. */
export const alertKinds = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const;

type AlertKind = keyof typeof alertKinds;

const isAlertKind = (value: string | undefined): AlertKind | undefined =>
  value === "note" ||
  value === "tip" ||
  value === "important" ||
  value === "warning" ||
  value === "caution"
    ? value
    : undefined;

const alertMarker = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

const toAlert = (quote: Blockquote) => {
  const first = quote.children[0];
  if (first?.type !== "paragraph") return;
  const text = first.children[0];
  if (text?.type !== "text") return;
  const match = alertMarker.exec(text.value);
  // Markdown after the marker on its line, like `[!NOTE] *x*`, isn't an alert on GitHub.
  if (!match || (!match[0].endsWith("\n") && first.children.length > 1)) return;
  const kind = isAlertKind(match[1]?.toLowerCase());
  if (!kind) return;
  text.value = text.value.slice(match[0].length);
  if (!text.value) first.children.shift();
  if (!first.children.length) quote.children.shift();
  const title: Paragraph = {
    type: "paragraph",
    children: [{ type: "text", value: alertKinds[kind] }],
    data: { hProperties: { className: ["markdown-alert-title"] } },
  };
  quote.children.unshift(title);
  quote.data = {
    ...quote.data,
    hProperties: { className: ["markdown-alert", `markdown-alert-${kind}`] },
  };
};

const visitQuotes = (nodes: RootContent[]) => {
  for (const node of nodes) {
    if (node.type === "blockquote") toAlert(node);
    if ("children" in node) visitQuotes(node.children);
  }
};

/**
 * GitHub alerts: a quote whose first line is only `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`
 * or `[!CAUTION]` becomes a callout with that title, its other Markdown kept. Runs before line
 * breaks become `<br>`, so the marker must stand alone on its own first line.
 */
export const remarkAlerts = () => (tree: Root) => visitQuotes(tree.children);

// The default GitHub schema, plus the classes remark-math marks math with and the alert classes
// open-dot's own transform sets. KaTeX runs after the sanitizer, on math the text can't style.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    blockquote: [
      [
        "className",
        "markdown-alert",
        ...Object.keys(alertKinds).map((kind) => `markdown-alert-${kind}`),
      ],
    ],
    p: [["className", "markdown-alert-title"]],
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

// Bundled file-type badges by language: a short label and a color, never a remote icon.
const icons: Record<string, [string, string]> = {
  typescript: ["TS", "#3178c6"],
  tsx: ["TSX", "#3178c6"],
  javascript: ["JS", "#d4b106"],
  jsx: ["JSX", "#d4b106"],
  json: ["{}", "#8a8a8a"],
  python: ["PY", "#3572a5"],
  rust: ["RS", "#b7410e"],
  go: ["GO", "#00add8"],
  swift: ["SW", "#f05138"],
  java: ["JV", "#b07219"],
  kotlin: ["KT", "#a97bff"],
  ruby: ["RB", "#cc342d"],
  php: ["PHP", "#777bb4"],
  c: ["C", "#555555"],
  cpp: ["C++", "#f34b7d"],
  csharp: ["C#", "#178600"],
  html: ["<>", "#e34c26"],
  css: ["CSS", "#563d7c"],
  scss: ["SCSS", "#c6538c"],
  markdown: ["MD", "#4a4a4a"],
  yaml: ["YML", "#cb171e"],
  yml: ["YML", "#cb171e"],
  toml: ["TOML", "#9c4221"],
  sql: ["SQL", "#e38c00"],
  zsh: ["$_", "#4eaa25"],
  bash: ["$_", "#4eaa25"],
  sh: ["$_", "#4eaa25"],
  shell: ["$_", "#4eaa25"],
  diff: ["±", "#6e7781"],
  dockerfile: ["DK", "#384d54"],
};

const iconAliases: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rs: "rust",
  rb: "ruby",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  shellscript: "bash",
  console: "bash",
  patch: "diff",
};

/** The badge for a language, or a generic file badge. */
export const fileIcon = (language: string | undefined): [string, string] =>
  icons[iconAliases[language ?? ""] ?? language ?? ""] ?? ["•", "#8a8a8a"];

const FileIcon = ({ language }: { language: string | undefined }) => {
  const [label, color] = fileIcon(language);
  return (
    <span className="file-icon" style={{ background: color }} aria-hidden="true">
      {label}
    </span>
  );
};

/** Code longer than this many lines starts folded to `foldShown` lines. */
export const foldAfter = 24;
export const foldShown = 12;

const Lines = ({ code, tokens }: { code: string; tokens: Token[][] | undefined }) =>
  tokens
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
    : code;

const CodeBlock = ({ language, code }: { language: string | undefined; code: string }) => {
  const [tokens, setTokens] = useState<Token[][]>();
  const [open, setOpen] = useState(false);
  const id = useId();
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
  const lines = code.split("\n");
  const folds = lines.length > foldAfter;
  const folded = folds && !open;
  return (
    <div className={`code-block${folded ? " folded" : ""}`}>
      <div className="code-head">
        <span className="code-language">
          <FileIcon language={language} />
          {language ?? "text"}
        </span>
        <Copy text={code} />
      </div>
      <pre id={id}>
        <code>
          {folded ? (
            <Lines
              code={lines.slice(0, foldShown).join("\n")}
              tokens={tokens?.slice(0, foldShown)}
            />
          ) : (
            <Lines code={code} tokens={tokens} />
          )}
        </code>
      </pre>
      {folds ? (
        <button
          type="button"
          className="code-fold"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {open ? "Collapse" : `Expand (${lines.length - foldShown} more lines)`}
        </button>
      ) : null}
    </div>
  );
};

const strip = (line: string | undefined) => (line ?? "").replace(/\r?\n$/, "");

/** The highlighted lines of one side of a file's diff, or undefined while plain. */
const useSide = (lines: readonly string[], language: string) => {
  const [tokens, setTokens] = useState<Token[][]>();
  const code = lines.map(strip).join("\n");
  useEffect(() => {
    let live = true;
    setTokens(undefined);
    if (language !== "text" && code)
      highlight(code, language)
        .then((found) => live && setTokens(found))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, language]);
  return tokens;
};

/** The language of a diffed file from its name, with Pierre's own filename map. */
export const diffLanguage = (file: { name: string; prevName?: string | undefined }) =>
  String(getFiletypeFromFileName(file.name || file.prevName || ""));

const DiffFile = ({ file }: { file: FileDiffMetadata }) => {
  const language = diffLanguage(file);
  const before = useSide(file.deletionLines, language);
  const after = useSide(file.additionLines, language);
  const rows: ReactNode[] = [
    <div className="diff-file" key="name">
      <FileIcon language={language} />
      {file.prevName && file.prevName !== file.name ? `${file.prevName} → ${file.name}` : file.name}
    </div>,
  ];
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const key = `${hunkIndex}`;
    rows.push(
      <div className="diff-row diff-hunk" key={`h${key}`}>
        {hunk.hunkSpecs?.trim()}
      </div>,
    );
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    const row = (kind: "add" | "del" | "same", index: number, id: string) => {
      const side = kind === "del" ? file.deletionLines : file.additionLines;
      const tokens = (kind === "del" ? before : after)?.[index];
      return (
        <div className={`diff-row diff-${kind}`} key={id}>
          <span className="diff-num">{kind === "add" ? "" : oldLine}</span>
          <span className="diff-num">{kind === "del" ? "" : newLine}</span>
          <span className="diff-sign">{kind === "add" ? "+" : kind === "del" ? "-" : " "}</span>
          <span className="diff-text">
            {tokens
              ? tokens.map((token, at) => (
                  <span key={at} style={token.htmlStyle}>
                    {token.content}
                  </span>
                ))
              : strip(side[index])}
          </span>
        </div>
      );
    };
    for (const [blockIndex, block] of hunk.hunkContent.entries()) {
      const id = `${key}-${blockIndex}`;
      if (block.type === "context") {
        for (let index = 0; index < block.lines; index++) {
          rows.push(row("same", block.additionLineIndex + index, `${id}-${index}`));
          oldLine++;
          newLine++;
        }
        continue;
      }
      for (let index = 0; index < block.deletions; index++) {
        rows.push(row("del", block.deletionLineIndex + index, `${id}-d${index}`));
        oldLine++;
      }
      for (let index = 0; index < block.additions; index++) {
        rows.push(row("add", block.additionLineIndex + index, `${id}-a${index}`));
        newLine++;
      }
    }
  }
  return <>{rows}</>;
};

/**
 * A unified diff as rows, from Pierre's parser, each side colored as its file's language; nothing
 * it parses becomes markup.
 */
export const DiffBlock = ({ code }: { code: string }) => {
  let files: FileDiffMetadata[];
  try {
    files = parsePatchFiles(code, undefined, true).flatMap((patch) => patch.files);
  } catch {
    files = [];
  }
  if (!files.some((file) => file.hunks.length))
    return <CodeBlock language={undefined} code={code} />;
  return (
    <div className="code-block diff">
      <div className="code-head">
        <span className="code-language">
          <FileIcon language="diff" />
          diff
        </span>
        <Copy text={code} />
      </div>
      <div className="diff-body">
        {files.map((file, index) => (
          <DiffFile key={index} file={file} />
        ))}
      </div>
    </div>
  );
};

/** A reply's remote media: the ones the daemon listed, how to load one, and the image viewer. */
export interface MediaContext {
  /** The reply's dot, session and message: with a media ID, what a loaded blob belongs to. */
  scope: string;
  list: readonly MediaView[];
  load: (id: string) => Promise<Result<Bytes>>;
  onOpenImage: (url: string) => void;
}

const Media = createContext<MediaContext | undefined>(undefined);

const listed = (media: MediaContext | undefined, raw: unknown) => {
  const key = mediaKey(raw);
  return key === undefined ? undefined : media?.list.find((entry) => entry.url === key);
};

/** Bytes of remote media the window holds as blob URLs at once; past it, media stay links. */
const mediaBudget = 96 * 1024 * 1024;
let mediaHeld = 0;

const Link = ({ href, children }: { href: unknown; children: ReactNode }) => {
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
};

/**
 * One listed image or video, loaded through the daemon into a blob URL that's revoked when it
 * goes. Until it loads, or if it can't, the link shows instead.
 */
const RemoteMedia = ({
  media,
  entry,
  alt,
  fallback,
}: {
  media: MediaContext;
  entry: MediaView;
  alt: string;
  fallback: ReactNode;
}) => {
  const [url, setURL] = useState<string>();
  const [failed, setFailed] = useState(false);
  // Bytes that passed the daemon's checks can still fail to decode or play: the link comes back.
  const [broken, setBroken] = useState(false);
  // A poll hands over an equal but new context: the blob, and a playing video, stay while the
  // reply and media are the same, and load again only for another one.
  const load = useRef(media.load);
  load.current = media.load;
  useEffect(() => {
    let live = true;
    let held = 0;
    let made: string | undefined;
    setURL(undefined);
    setFailed(false);
    setBroken(false);
    void load.current(entry.id).then((result) => {
      if (!live) return;
      const size = result.ok ? result.value.data.byteLength : 0;
      if (
        !result.ok ||
        !result.value.mime.startsWith(`${entry.kind}/`) ||
        mediaHeld + size > mediaBudget
      ) {
        setFailed(true);
        return;
      }
      held = size;
      mediaHeld += held;
      made = URL.createObjectURL(
        new Blob([new Uint8Array(result.value.data)], { type: result.value.mime }),
      );
      setURL(made);
    });
    return () => {
      live = false;
      mediaHeld -= held;
      if (made) URL.revokeObjectURL(made);
    };
  }, [media.scope, entry.id, entry.kind]);
  if (!url || broken)
    return (
      <span
        className="remote-media-pending"
        data-media={entry.id}
        data-failed={failed || broken || undefined}
      >
        {fallback}
      </span>
    );
  const label = alt || (entry.kind === "image" ? "Image" : "Video");
  return entry.kind === "image" ? (
    <button
      type="button"
      className="remote-image"
      data-media={entry.id}
      aria-label={`Open image: ${label}`}
      title={entry.url}
      onClick={() => media.onOpenImage(url)}
    >
      <img src={url} alt={alt} onError={() => setBroken(true)} />
    </button>
  ) : (
    <video
      className="remote-video"
      data-media={entry.id}
      src={url}
      aria-label={label}
      title={entry.url}
      controls
      muted
      playsInline
      preload="metadata"
      onError={() => setBroken(true)}
    />
  );
};

const components: Components = {
  a: function Anchor({ href, children, node }) {
    const media = useContext(Media);
    // Only a bare link, its text the URL itself, previews the image or video it names.
    const entry = node && textOf(node) === href ? listed(media, href) : undefined;
    const link = <Link href={href}>{children}</Link>;
    return media && entry ? (
      <RemoteMedia media={media} entry={entry} alt="" fallback={link} />
    ) : (
      link
    );
  },
  // Remote images load only through the daemon, and only the ones it listed for this reply.
  img: function Image({ src, alt }) {
    const media = useContext(Media);
    const entry = listed(media, src);
    const label = `[image${alt ? `: ${alt}` : ""}]`;
    return media && entry ? (
      <RemoteMedia
        media={media}
        entry={entry}
        alt={alt ?? ""}
        fallback={<Link href={entry.url}>{label}</Link>}
      />
    ) : safeExternalURL(src) ? (
      // Not previewed, such as past the listing cap: still a link, opened outside the app.
      <Link href={src}>{label}</Link>
    ) : (
      <span className="image-inert">{label}</span>
    );
  },
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
export const Markdown = memo(
  ({ text, media }: { text: string; media?: MediaContext | undefined }) => (
    <Media.Provider value={media}>
      <div className="markdown">
        <ReactMarkdown
          skipHtml
          remarkPlugins={[
            remarkGfm,
            [remarkMath, { singleDollarTextMath: true }],
            remarkAlerts,
            remarkBreaks,
          ]}
          rehypePlugins={[
            [rehypeSanitize, schema],
            [rehypeKatex, katexOptions],
          ]}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </div>
    </Media.Provider>
  ),
);
