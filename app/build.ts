// Builds the app into app/build: the renderer with Vite+, main and the sandboxed preload with Bun.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const out = join(root, "build");
rmSync(out, { recursive: true, force: true });

const vite = Bun.spawnSync(["vp", "build", root], { stdout: "inherit", stderr: "inherit" });
if (vite.exitCode !== 0) throw new Error("The renderer build failed.");

for (const name of ["main", "preload"]) {
  const result = await Bun.build({
    entrypoints: [join(root, `${name}.ts`)],
    outdir: out,
    naming: `${name}.cjs`,
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  if (!result.success) throw new AggregateError(result.logs, `The ${name} build failed.`);
}

// The clipboard helper Slack pickup needs, built from source; packaging keeps it outside the ASAR
// archive, where it can run, and signs it ad hoc with the app.
const helper = Bun.spawnSync(
  [
    "xcrun",
    "--sdk",
    "macosx",
    "clang",
    "-fobjc-arc",
    "-O2",
    "-framework",
    "AppKit",
    "-o",
    join(out, "clipboard-helper"),
    join(root, "clipboard.m"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (helper.exitCode !== 0) throw new Error("The clipboard helper build failed.");

const manifest: unknown = await Bun.file(join(root, "..", "package.json")).json();
const version =
  typeof manifest === "object" && manifest !== null && "version" in manifest
    ? String(manifest.version)
    : "0.0.0";
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({
    name: "open-dot",
    productName: "open-dot",
    version,
    main: "main.cjs",
    private: true,
  }),
);
console.log("Built app/build.");
