import { defineConfig } from "vite";
import { devProxy } from "./src/dev-proxy.js";

export default defineConfig({
  server: { proxy: devProxy() },
});
