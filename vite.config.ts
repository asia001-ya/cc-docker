import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发服务器固定端口 5420（1420 落在 Hyper-V/WSL 动态保留区间 1351-1450 内，Docker Desktop 装好后无法监听）；不清屏
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5420,
    strictPort: true,
    // The terminal preview imports the pure formatter from docker/rootfs.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
