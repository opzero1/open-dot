// Builds the app into app/build: the renderer with Vite+, main and the sandboxed preload with Bun.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// The app's icon for packaging, from the owner's 1024-pixel PNG: macOS's sips scales each size
// into an iconset and iconutil makes the .icns. Packaging leaves it out of the app's archive.
const iconset = join(mkdtempSync(join(tmpdir(), "open-dot-icon-")), "icon.iconset");
mkdirSync(iconset);
try {
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      const pixels = String(size * scale);
      const sips = Bun.spawnSync(
        [
          "sips",
          "-z",
          pixels,
          pixels,
          join(root, "resources", "app-icon.png"),
          "--out",
          join(iconset, name),
        ],
        { stdout: "ignore", stderr: "inherit" },
      );
      if (sips.exitCode !== 0) throw new Error(`Scaling the app icon to ${name} failed.`);
    }
  const icns = Bun.spawnSync(["iconutil", "-c", "icns", iconset, "-o", join(out, "icon.icns")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (icns.exitCode !== 0) throw new Error("Making the app icon failed.");
} finally {
  rmSync(dirname(iconset), { recursive: true, force: true });
}

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
