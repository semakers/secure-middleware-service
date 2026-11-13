import { defineConfig } from 'vitest/config';

// Two projects: fast unit tests, and the HTTP integration suite. The integration
// suite runs in-process (supertest against the Express app) by default, and
// against a running container when E2E_BASE_URL is set (see tests/integration/support/target.ts).
export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // The remote target is one shared server: run files and tests in order.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // server.ts is the 10-line process entry point (reads process.env, calls start()).
      exclude: ['src/server.ts'],
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: process.env.COVERAGE_DIR ?? 'coverage',
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 },
    },
  },
});
