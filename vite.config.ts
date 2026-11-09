import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import Icons from "unplugin-icons/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
    Icons({ compiler: "jsx", jsx: "react" }),
  ],
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      // Cloudflare Workers Builds hits EMFILE ("too many open files") with Rollup's default
      // of 1000 concurrent file reads (lucide-react alone is ~1,600 icon modules).
      maxParallelFileOps: 64,
    },
  },
  server: {
    proxy: {
      "/proxy/replicate": {
        target: "https://api.replicate.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/replicate/, ""),
      },
      "/proxy/openai": {
        target: "https://api.openai.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/openai/, ""),
      },
    },
  },
});
