import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import { devProxy } from "./src/dev-proxy.js";

const COMPRESSIBLE = /\.(js|css|html|svg|json|txt)$/;

/** Emit `.br`/`.gz` siblings at build so the server can serve precompressed
 * bytes (web spec §4.3, server §6.6). */
function precompress(): Plugin {
  return {
    name: "osc-precompress",
    apply: "build",
    closeBundle() {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) {
            walk(path);
            continue;
          }
          if (!COMPRESSIBLE.test(entry)) continue;
          const contents = readFileSync(path);
          writeFileSync(`${path}.br`, brotliCompressSync(contents));
          writeFileSync(`${path}.gz`, gzipSync(contents, { level: 9 }));
        }
      };
      walk(join(dirname(fileURLToPath(import.meta.url)), "dist"));
    },
  };
}

export default defineConfig({
  server: { proxy: devProxy() },
  plugins: [precompress()],
});
