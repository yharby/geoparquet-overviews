import { defineConfig } from 'vitest/config';

// A separate config from the default `vitest.config.ts`, deliberately outside
// `pnpm test`. This suite hits real network URLs (source.coop), so it is run
// only via `pnpm bench`, never picked up by the default `src/**/*.test.ts`
// include the plain `vitest run` uses.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench/**/*.bench.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // This suite reports its measurements via console.log. Let them through
    // instead of vitest's default per-test interception and grouping.
    disableConsoleIntercept: true,
  },
});
