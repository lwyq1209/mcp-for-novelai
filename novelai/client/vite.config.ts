import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // QA profiles, unpacked releases, and generated screenshots live under
    // .tmp. Watching those Chromium databases can lock files on Windows and
    // make the dev renderer consume gigabytes of memory or stop responding.
    watch: {
      ignored: ["**/.tmp/**", "**/release/**", "**/mobile/build/**"],
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.{ts,tsx}"],
    // Tests never touch the real data root: a throwaway NOVELAI_DATA_DIR unless one is set.
    globalSetup: ["./scripts/vitest-data-dir.mjs"],
    // Test files run in parallel, and some load the large electron/ipc/nai.ts or do
    // real file work, which can exceed vitest's 5 s default on a busy machine. The
    // timeouts are hang guards only: no test outcome depends on how fast the machine
    // is (waits are on conditions, see src/test-support/wait-until.ts), so a failure
    // is a real failure and is not retried. Windows gets more room: every SQLite commit and atomic file write ends in
    // a FlushFileBuffers that is 10-50x slower there (most on CI runners), so the file-heavy tests take that much longer.
    testTimeout: process.platform === "win32" ? 120000 : 30000,
    hookTimeout: process.platform === "win32" ? 120000 : 30000,
    retry: 0,
  },
});
