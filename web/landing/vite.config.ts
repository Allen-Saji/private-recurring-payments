import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist-landing", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 4174, strictPort: true },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
});
