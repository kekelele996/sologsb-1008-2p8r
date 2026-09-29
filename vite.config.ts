import { qwikVite } from "@builder.io/qwik/optimizer";
import { qwikCity } from "@builder.io/qwik-city/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [qwikCity(), qwikVite(), tsconfigPaths(), tailwindcss()],
  server: { headers: { "Cache-Control": "public, max-age=0" } },
  preview: { headers: { "Cache-Control": "public, max-age=600" } },
});
