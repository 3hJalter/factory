import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Khi chạy `npm run dev:web`, Vite chuyển /api và /ws sang server nhà máy đang chạy.
const target = `http://127.0.0.1:${process.env.FACTORY_PORT ?? "7319"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target, changeOrigin: true },
      "/ws": {
        target,
        ws: true,
        changeOrigin: true,
        // Server chỉ nhận WebSocket từ chính nó; đổi Origin của Vite sang địa chỉ server.
        configure: (proxy) => proxy.on("proxyReqWs", (req) => req.setHeader("origin", target)),
      },
    },
  },
});
