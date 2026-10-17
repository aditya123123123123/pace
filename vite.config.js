import { defineConfig } from "vite";
import { cpSync, existsSync, createReadStream } from "node:fs";
import { join, resolve, extname } from "node:path";

// pdf.js loads image decoders (JBIG2/JPEG2000 WASM — what most library/copier scans use),
// CMaps, standard fonts and ICC profiles at runtime. Without them those scans render blank
// and OCR sees an empty page. Serve them from node_modules in dev; copy them on build.
const PDFJS = resolve("node_modules/pdfjs-dist");
const ASSET_DIRS = ["wasm", "cmaps", "standard_fonts", "iccs"];
const MIME = { ".wasm": "application/wasm", ".js": "text/javascript", ".bcmap": "application/octet-stream" };

function pdfjsAssets() {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/+/, "");
        const file = join(PDFJS, rel);
        if (!ASSET_DIRS.includes(rel.split("/")[0]) || !file.startsWith(PDFJS) || !existsSync(file)) return next();
        res.setHeader("Content-Type", MIME[extname(file)] || "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(opts) {
      const out = opts.dir || resolve("dist");
      for (const d of ASSET_DIRS) cpSync(join(PDFJS, d), join(out, "pdfjs", d), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets()],
  server: { allowedHosts: [".ts.net"] },
  preview: { allowedHosts: [".ts.net"] },
});
