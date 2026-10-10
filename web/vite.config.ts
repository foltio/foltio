import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  plugins: [react()],
  resolve: { alias: { "node:crypto": here("./src/crypto-shim.ts") } },
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets" },
  server: {
    port: 5199,
    host: "127.0.0.1",
    fs: { allow: [here("..")] },
    proxy: { "/api": "http://127.0.0.1:8810", "/mcp": "http://127.0.0.1:8810" },
  },
});
