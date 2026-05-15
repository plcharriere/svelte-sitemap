import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Pure-Node tests against the library source. handle.ts no longer
		// imports the virtual `virtual:sitemap/routes` module — tests pass
		// `routes` directly via the SitemapConfig — so no alias/stub is needed.
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html', 'lcov'],
			include: ['src/lib/**/*.ts'],
			// `index.ts` is just re-exports — nothing to cover.
			exclude: ['src/lib/**/*.d.ts', 'src/lib/index.ts'],
			thresholds: {
				lines: 95,
				branches: 90,
				functions: 95,
				statements: 95
			}
		}
	}
});
