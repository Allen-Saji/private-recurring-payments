import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const file = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  publicDir: file("landing/public"),
  build: {
    outDir: "dist-product",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: file("landing/index.html"),
        hub: file("hub/index.html"),
        wallet: file("index.html"),
        invoices: file("billing/index.html"),
        agreements: file("workspace/index.html"),
      },
    },
  },
});
