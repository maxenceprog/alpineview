import { defineConfig } from "vite";

import { baseConfig } from "./vite.common.js";

export default defineConfig({
  ...baseConfig,
  define: {
    __TEST_CONTROLS__: "false",
    __API_BASE_URL__: JSON.stringify(""),
  },
});
