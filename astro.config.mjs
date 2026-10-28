import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

const chromiumBinDirectory = fileURLToPath(
  new URL(
    "./node_modules/@sparticuz/chromium/bin/",
    import.meta.url,
  ),
);

const chromiumFiles = readdirSync(
  chromiumBinDirectory,
  {
    withFileTypes: true,
  },
)
  .filter((entry) => entry.isFile())
  .map(
    (entry) =>
      `node_modules/@sparticuz/chromium/bin/${entry.name}`,
  );

export default defineConfig({
  output: "server",

  adapter: vercel({
    maxDuration: 60,
    includeFiles: chromiumFiles,
  }),

  vite: {
    ssr: {
      external: [
        "@sparticuz/chromium",
        "playwright-core",
      ],
    },
  },
});