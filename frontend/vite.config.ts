import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// В разработке запросы к /api уходят на локальный бэкенд. Порты можно поменять переменными
// PORT и API_PORT: когда проект запущен дважды на одной машине, 3000 и 8000 уже заняты.
// Типов Node в проекте нет, а ради двух переменных тащить их не хочется
declare const process: { env: Record<string, string | undefined> };

const ui = Number(process.env.PORT ?? 3000);
const api = Number(process.env.API_PORT ?? 8000);

export default defineConfig({
  plugins: [react()],
  server: {
    port: ui,
    proxy: { "/api": `http://localhost:${api}` },
  },
});
