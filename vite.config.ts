import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: { external: ["better-sqlite3"] },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: { build: { outDir: "dist-electron" } },
      },
    }),
  ],
  build: { outDir: "dist" },
});
