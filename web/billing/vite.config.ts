import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../landing/public", import.meta.url)),
  build: { outDir: "../dist-billing", emptyOutDir: true },
});
