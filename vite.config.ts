import { defineConfig } from "vite-plus";

export default defineConfig({
  base: "./",
  lint: { options: { typeAware: true, typeCheck: true } },
});
