import { defineConfig } from "vite";
import pngquantBridge from "./vite-plugin-pngquant.js";

export default defineConfig({
  base: "./",
  worker: {
    format: "es",
  },
  // 仅在 dev / preview 下挂载 Packages/pngquant.exe 桥接；build 产出为纯静态站点
  plugins: [pngquantBridge()],
});
