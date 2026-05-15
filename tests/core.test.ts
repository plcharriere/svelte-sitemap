import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
	SitemapStore,
	buildEntries,
	enumerateGroups,
	resolveBasename,
	resolveCache,
	resolveExclude,
	resolveExternalSitemaps,
	resolveMaxEntries,
	resolveStaticSiteUrl,
	validateConfig,
	type ExcludeMatcher
} from '../src/lib/core.js';
import {
	DEFAULT_GROUP,
	type CacheAdapter,
	type PathConfig,
	type SitemapConfig
} from '../src/lib/types.js';

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

function noMatchers(): ExcludeMatcher[] {
	return [];
}

/**
 * Test shorthand: most tests pre-date the routes/paths collapse. They wrote
 * "auto-discovered routes" as `routes: ['/foo', '/bar/[id]']` separately from
 * `paths`. Now that routes are gone, this helper merges them into `paths` as
 * `{ '/foo': {}, '/bar/[id]': {} }` (config.paths still wins on collisions).
 */
function vcfg(
	config: SitemapConfig,
	routes: string[],
	matchers: ExcludeMatcher[]
): void {
	const auto: Record<string, PathConfig> = {};
	for (const r of routes) auto[r] = {};
	validateConfig({ ...config, paths: { ...auto, ...(config.paths ?? {}) } }, matchers);
}

/**
 * Same shorthand for `buildEntries` — `routes` shorthand merged into
 * `config.paths` as `{ '/foo': {} }` (config.paths overrides on collision).
 * Hoisted so both the buildEntries describe and the i18n describe can use it.
 */
function ctx(
	overrides: Partial<{
		siteUrl: string;
		routes: string[];
		config: SitemapConfig;
		excludeMatchers: ExcludeMatcher[];
	}> = {}
) {
	const auto: Record<string, PathConfig> = {};
	for (const r of overrides.routes ?? []) auto[r] = {};
	const userConfig = overrides.config ?? {};
	return {
		siteUrl: overrides.siteUrl ?? 'https://example.com',
		config: { ...userConfig, paths: { ...auto, ...(userConfig.paths ?? {}) } },
		excludeMatchers: overrides.excludeMatchers ?? noMatchers()
	};
}

function makeMemoryAdapter(): CacheAdapter & { store: Map<string, unknown> } {
	const store = new Map<string, unknown>();
	return {
		store,
		get: (k) => store.get(k) ?? null,
		set: (k, v) => {
			store.set(k, v);
		}
	};
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	warnSpy.mockRestore();
});

// =============================================================================
// resolveExclude — string validation, glob compilation
// =============================================================================

describe('resolveExclude', () => {
	it('returns empty array when exclude is undefined', () => {
		expect(resolveExclude({})).toEqual([]);
	});

	it('returns empty array when exclude is empty', () => {
		expect(resolveExclude({ exclude: [] })).toEqual([]);
	});

	it('throws on non-string entry', () => {
		expect(() =>
			resolveExclude({ exclude: [null as unknown as string] })
		).toThrow(/must be a non-empty string starting with "\/"/);
	});

	it('throws on empty string', () => {
		expect(() => resolveExclude({ exclude: [''] })).toThrow(
			/must be a non-empty string/
		);
	});

	it('throws when entry does not start with /', () => {
		expect(() => resolveExclude({ exclude: ['admin'] })).toThrow(
			/starting with "\/"/
		);
	});

	it('throws on "/" (matches every route)', () => {
		expect(() => resolveExclude({ exclude: ['/'] })).toThrow(
			/would match every route/
		);
	});

	it('throws on "/**" (matches every route)', () => {
		expect(() => resolveExclude({ exclude: ['/**'] })).toThrow(
			/would match every route/
		);
	});

	it('reports the index of the bad rule', () => {
		expect(() => resolveExclude({ exclude: ['/ok', '/'] })).toThrow(
			/exclude\[1\]/
		);
	});

	describe('literal patterns (no glob chars)', () => {
		it('matches the exact path', () => {
			const [m] = resolveExclude({ exclude: ['/admin'] });
			expect(m('/admin')).toBe(true);
		});

		it('matches descendants (prefix semantics)', () => {
			const [m] = resolveExclude({ exclude: ['/admin'] });
			expect(m('/admin/users')).toBe(true);
			expect(m('/admin/users/1/edit')).toBe(true);
		});

		it('does not match siblings whose name starts with the rule', () => {
			const [m] = resolveExclude({ exclude: ['/admin'] });
			expect(m('/administrator')).toBe(false);
			expect(m('/admin-panel')).toBe(false);
		});

		it('does not match unrelated paths', () => {
			const [m] = resolveExclude({ exclude: ['/admin'] });
			expect(m('/blog')).toBe(false);
			expect(m('/')).toBe(false);
		});

		it('handles trailing-slash literals (matches descendants only)', () => {
			const [m] = resolveExclude({ exclude: ['/admin/'] });
			expect(m('/admin')).toBe(false); // strict — trailing slash ≠ no slash
			expect(m('/admin/users')).toBe(true);
		});

		it('preserves SvelteKit [param] route patterns as literal', () => {
			// `[` does not trigger glob compilation — `/blog/[id]` excludes the
			// literal route pattern (and its descendants).
			const [m] = resolveExclude({ exclude: ['/blog/[id]'] });
			expect(m('/blog/[id]')).toBe(true);
			expect(m('/blog/[id]/edit')).toBe(true);
			expect(m('/blog/foo')).toBe(false); // not a char class
		});

		it('treats [abc] as literal text, NOT as a glob char class', () => {
			// Design rule: `[` is reserved for SvelteKit `[param]` route paths.
			// Without a `*` or `?` to trigger glob compilation, `/[abc]` is a
			// literal path segment (matches the exact bracket-letter-bracket
			// route, plus descendants), not a regex-style char class.
			const [m] = resolveExclude({ exclude: ['/[abc]'] });
			expect(m('/[abc]')).toBe(true);
			expect(m('/[abc]/x')).toBe(true);
			expect(m('/a')).toBe(false); // would match if treated as char class
			expect(m('/b')).toBe(false);
			expect(m('/c')).toBe(false);
		});

		it('treats {a,b} as literal text, NOT as glob alternation', () => {
			// Design rule: `{` is reserved (collides with rare route patterns
			// and keeps glob detection simple). `/{a,b}` matches the literal
			// path `/{a,b}`, not "either /a or /b". Use multiple exclude
			// entries for alternation.
			const [m] = resolveExclude({ exclude: ['/{a,b}'] });
			expect(m('/{a,b}')).toBe(true);
			expect(m('/a')).toBe(false);
			expect(m('/b')).toBe(false);
		});
	});

	describe('glob patterns', () => {
		it('* matches within a single segment', () => {
			const [m] = resolveExclude({ exclude: ['/blog/draft-*'] });
			expect(m('/blog/draft-foo')).toBe(true);
			expect(m('/blog/draft-')).toBe(true); // zero or more chars
			expect(m('/blog/draft-foo/bar')).toBe(false); // doesn't cross /
			expect(m('/blog/published')).toBe(false);
		});

		it('** at trailing position matches anything after the slash (not the parent)', () => {
			const [m] = resolveExclude({ exclude: ['/preview/**'] });
			expect(m('/preview')).toBe(false); // strict glob
			expect(m('/preview/x')).toBe(true);
			expect(m('/preview/x/y/z')).toBe(true);
		});

		it('/**/ in the middle collapses to "zero or more segments"', () => {
			const [m] = resolveExclude({ exclude: ['/api/**/private'] });
			expect(m('/api/private')).toBe(true);
			expect(m('/api/v1/private')).toBe(true);
			expect(m('/api/v1/v2/private')).toBe(true);
			expect(m('/api/private/foo')).toBe(false);
			expect(m('/api')).toBe(false);
		});

		it('/**/ at the leading position works (e.g. /**/secret)', () => {
			const [m] = resolveExclude({ exclude: ['/**/secret'] });
			expect(m('/secret')).toBe(true);
			expect(m('/admin/secret')).toBe(true);
			expect(m('/a/b/c/secret')).toBe(true);
			expect(m('/secret/foo')).toBe(false);
			expect(m('/secretly')).toBe(false);
		});

		it('? matches exactly one non-slash character', () => {
			const [m] = resolveExclude({ exclude: ['/v?/api'] });
			expect(m('/v1/api')).toBe(true);
			expect(m('/vX/api')).toBe(true);
			expect(m('/v/api')).toBe(false); // zero chars
			expect(m('/v12/api')).toBe(false); // two chars
		});

		it('** without surrounding slashes greedily crosses segments', () => {
			const [m] = resolveExclude({ exclude: ['/foo**bar'] });
			expect(m('/foobar')).toBe(true);
			expect(m('/foo/bar')).toBe(true);
			expect(m('/fooXbar')).toBe(true);
		});

		it('escapes regex metacharacters in literal portions', () => {
			const [m] = resolveExclude({ exclude: ['/a.b/*'] });
			expect(m('/a.b/x')).toBe(true);
			expect(m('/aXb/x')).toBe(false); // `.` is literal, not regex wildcard
		});

		it('escapes parens, dollars, and braces in literal portions', () => {
			const [m] = resolveExclude({ exclude: ['/(group)/$x/{a}/*'] });
			expect(m('/(group)/$x/{a}/foo')).toBe(true);
		});

		it('combines multiple matchers with OR semantics', () => {
			const ms = resolveExclude({
				exclude: ['/admin', '/preview/**', '/v?/api']
			});
			const isExcl = (p: string) => ms.some((m) => m(p));
			expect(isExcl('/admin')).toBe(true);
			expect(isExcl('/admin/users')).toBe(true);
			expect(isExcl('/preview/foo')).toBe(true);
			expect(isExcl('/v1/api')).toBe(true);
			expect(isExcl('/blog')).toBe(false);
		});
	});
});

// =============================================================================
// validateConfig
// =============================================================================

describe('validateConfig', () => {
	it('accepts an empty config', () => {
		expect(() => vcfg({}, [], noMatchers())).not.toThrow();
	});

	describe('i18n', () => {
		it('throws when defaultLocale is missing from locales', () => {
			expect(() =>
				vcfg(
					{ i18n: { defaultLocale: 'en', locales: { fr: {} } } },
					[],
					noMatchers()
				)
			).toThrow(/i18n\.defaultLocale "en" is not in i18n\.locales/);
		});

		it('accepts a defaultLocale present in locales', () => {
			expect(() =>
				vcfg(
					{
						i18n: { defaultLocale: 'en', locales: { en: {}, fr: {} } }
					},
					[],
					noMatchers()
				)
			).not.toThrow();
		});

		it('accepts no defaultLocale at all', () => {
			expect(() =>
				vcfg(
					{ i18n: { locales: { en: {}, fr: {} } } },
					[],
					noMatchers()
				)
			).not.toThrow();
		});

		it('warns when domain mode has no domain configured', () => {
			vcfg(
				{ i18n: { mode: 'domain', locales: { en: {}, fr: {} } } },
				[],
				noMatchers()
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(/i18n\.mode === 'domain' but no locale has a domain/)
			);
		});

		it('does not warn when at least one domain is configured', () => {
			vcfg(
				{
					i18n: {
						mode: 'domain',
						locales: { en: {}, fr: { domains: ['fr.example.com'] } }
					}
				},
				[],
				noMatchers()
			);
			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe('paths', () => {
		it('throws on function pathConfig for a static route', () => {
			expect(() =>
				vcfg(
					{ paths: { '/about': () => [] } },
					['/about'],
					noMatchers()
				)
			).toThrow(/static path — use \{ group: '\.\.\.' \}/);
		});

		it('accepts function pathConfig for a dynamic route', () => {
			expect(() =>
				vcfg(
					{ paths: { '/blog/[id]': () => [] } },
					['/blog/[id]'],
					noMatchers()
				)
			).not.toThrow();
		});

		it('throws when value is null', () => {
			expect(() =>
				vcfg(
					{ paths: { '/blog/[id]': null as never } },
					['/blog/[id]'],
					noMatchers()
				)
			).toThrow(/must be a function or \{ group\?, resolve\? \}, got null/);
		});

		it('throws when value is a primitive', () => {
			expect(() =>
				vcfg(
					{ paths: { '/blog/[id]': 'oops' as never } },
					['/blog/[id]'],
					noMatchers()
				)
			).toThrow(/got string/);
		});

		it('throws on invalid group name', () => {
			expect(() =>
				vcfg(
					{
						paths: { '/blog/[id]': { group: 'Bad-Name', resolve: () => [] } }
					},
					['/blog/[id]'],
					noMatchers()
				)
			).toThrow(/invalid group name "Bad-Name"/);
		});

		it('accepts the default group (empty string) implicitly', () => {
			expect(() =>
				vcfg(
					{ paths: { '/blog/[id]': { resolve: () => [] } } },
					['/blog/[id]'],
					noMatchers()
				)
			).not.toThrow();
		});

		it('does NOT warn when a paths key is not in discovered routes (custom URL)', () => {
			// A paths key that isn't a discovered route is no longer treated as
			// a typo — it's an opt-in custom URL. No warning should fire.
			vcfg(
				{ paths: { '/legacy/[id]': () => [] } },
				['/blog/[id]'],
				noMatchers()
			);
			const calls = warnSpy.mock.calls.map((c: unknown[]) => c[0]);
			expect(calls.some((m: string) => /doesn't match any discovered route/.test(m))).toBe(
				false
			);
		});

		it('warns when paths key (discovered route) is excluded by config.exclude', () => {
			const matchers = resolveExclude({ exclude: ['/admin'] });
			vcfg(
				{
					exclude: ['/admin'],
					paths: { '/admin/[id]': { group: 'admin', resolve: () => [] } }
				},
				['/admin/[id]'],
				matchers
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/paths\["\/admin\/\[id\]"\] is configured but excluded by config\.exclude/
				)
			);
		});

		it('warns when a CUSTOM paths key is excluded too', () => {
			// Same warning fires whether the key is a discovered route or a custom URL.
			const matchers = resolveExclude({ exclude: ['/admin'] });
			vcfg(
				{
					exclude: ['/admin'],
					paths: { '/admin/legacy': { group: 'admin' } }
				},
				[], // not a discovered route — custom URL
				matchers
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(/paths\["\/admin\/legacy"\] is configured but excluded/)
			);
		});
	});

	describe('missing-resolver warnings', () => {
		it('warns for an auto-discovered dynamic route with no resolver', () => {
			// `vcfg` translates the routes shorthand into `paths['/blog/[id]'] = {}`,
			// which is a dynamic pattern with no resolver — the warning fires.
			vcfg({}, ['/blog/[id]'], noMatchers());
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/paths\["\/blog\/\[id\]"\] is a dynamic pattern with no resolver/
				)
			);
		});

		it('warns when paths entry has a group but no resolver', () => {
			vcfg(
				{ paths: { '/blog/[id]': { group: 'blog' } } },
				['/blog/[id]'],
				noMatchers()
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/paths\["\/blog\/\[id\]"\] is a dynamic pattern with no resolver/
				)
			);
		});

		it('does not warn when a resolver is provided', () => {
			vcfg(
				{ paths: { '/blog/[id]': () => [] } },
				['/blog/[id]'],
				noMatchers()
			);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('does not warn for static routes', () => {
			vcfg({}, ['/about'], noMatchers());
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('skips excluded routes — no missing-resolver warning', () => {
			// The excluded path still triggers a "configured but excluded" warning
			// (separate concern). What we assert here is that the missing-resolver
			// warning does NOT fire for excluded paths.
			const matchers = resolveExclude({ exclude: ['/admin'] });
			vcfg({ exclude: ['/admin'] }, ['/admin/[id]'], matchers);
			const calls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
			expect(calls.some((m: string) => m.includes('is a dynamic pattern with no resolver'))).toBe(
				false
			);
		});

		it('warns for any dynamic paths key that has no resolver', () => {
			vcfg(
				{ paths: { '/external/[id]': { group: 'external' } } },
				[], // no discovered routes — `/external/[id]` is custom
				noMatchers()
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/paths\["\/external\/\[id\]"\] is a dynamic pattern with no resolver/
				)
			);
		});
	});
});

// =============================================================================
// resolveCache
// =============================================================================

describe('resolveCache', () => {
	it('returns defaults when no cache is configured', () => {
		const r = resolveCache({});
		expect(r.ttl).toBe(60 * 60);
		expect(r.adapter).toBeNull();
	});

	it('uses cache.ttl when provided', () => {
		const r = resolveCache({ cache: { ttl: 120 } });
		expect(r.ttl).toBe(120);
		expect(r.adapter).toBeNull();
	});

	it('throws when ttl is not finite', () => {
		expect(() =>
			resolveCache({ cache: { ttl: NaN as never } })
		).toThrow(/cache\.ttl must be a positive number/);
	});

	it('throws when ttl is < 1', () => {
		expect(() => resolveCache({ cache: { ttl: 0 } })).toThrow(
			/positive number/
		);
		expect(() => resolveCache({ cache: { ttl: -5 } })).toThrow(
			/positive number/
		);
	});

	it('returns adapter when both get and set are functions', () => {
		const get = vi.fn();
		const set = vi.fn();
		const r = resolveCache({ cache: { get, set } });
		expect(r.adapter).not.toBeNull();
		expect(r.adapter?.get).toBe(get);
		expect(r.adapter?.set).toBe(set);
	});

	it('throws when only get is provided', () => {
		expect(() =>
			resolveCache({ cache: { get: () => null } as never })
		).toThrow(/requires both `get` and `set`/);
	});

	it('throws when only set is provided', () => {
		expect(() =>
			resolveCache({ cache: { set: () => undefined } as never })
		).toThrow(/requires both `get` and `set`/);
	});
});

// =============================================================================
// resolveMaxEntries
// =============================================================================

describe('resolveMaxEntries', () => {
	it('defaults to 50000', () => {
		expect(resolveMaxEntries({})).toBe(50_000);
	});

	it('returns the configured value when within range', () => {
		expect(resolveMaxEntries({ maxEntries: 1000 })).toBe(1000);
	});

	it('throws on non-integer values', () => {
		expect(() => resolveMaxEntries({ maxEntries: 1.5 })).toThrow(
			/positive integer/
		);
	});

	it('throws on values < 1', () => {
		expect(() => resolveMaxEntries({ maxEntries: 0 })).toThrow();
		expect(() => resolveMaxEntries({ maxEntries: -1 })).toThrow();
	});

	it('clamps to protocol max (50000) and warns', () => {
		expect(resolveMaxEntries({ maxEntries: 100_000 })).toBe(50_000);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/exceeds the sitemap protocol limit/)
		);
	});
});

// =============================================================================
// resolveBasename
// =============================================================================

describe('resolveBasename', () => {
	it("defaults to 'sitemap'", () => {
		expect(resolveBasename({})).toBe('sitemap');
	});

	it('accepts valid basenames', () => {
		expect(resolveBasename({ basename: 'urls' })).toBe('urls');
		expect(resolveBasename({ basename: 'site_map-2024' })).toBe('site_map-2024');
	});

	it('throws on uppercase', () => {
		expect(() => resolveBasename({ basename: 'SiteMap' })).toThrow(
			/start with a lowercase letter/
		);
	});

	it('throws on leading non-letter', () => {
		expect(() => resolveBasename({ basename: '1map' })).toThrow();
		expect(() => resolveBasename({ basename: '_map' })).toThrow();
		expect(() => resolveBasename({ basename: '-map' })).toThrow();
	});

	it('throws on empty string', () => {
		expect(() => resolveBasename({ basename: '' })).toThrow();
	});

	it('throws on special characters', () => {
		expect(() => resolveBasename({ basename: 'site.map' })).toThrow();
		expect(() => resolveBasename({ basename: 'site/map' })).toThrow();
	});
});

// =============================================================================
// resolveExternalSitemaps
// =============================================================================

describe('resolveExternalSitemaps', () => {
	it('returns empty array when undefined', () => {
		expect(resolveExternalSitemaps({})).toEqual([]);
	});

	it('passes through valid http and https URLs', () => {
		const urls = ['http://a.com/sitemap.xml', 'https://b.com/sitemap.xml'];
		expect(resolveExternalSitemaps({ externalSitemaps: urls })).toEqual(urls);
	});

	it('throws on malformed URLs', () => {
		expect(() =>
			resolveExternalSitemaps({ externalSitemaps: ['not a url'] })
		).toThrow(/not a valid absolute http\(s\) URL/);
	});

	it('throws on non-http(s) protocols', () => {
		expect(() =>
			resolveExternalSitemaps({ externalSitemaps: ['ftp://a.com/sitemap.xml'] })
		).toThrow(/must use http: or https:/);
	});

	it('rejects httpx:// (exact protocol match, not startsWith)', () => {
		expect(() =>
			resolveExternalSitemaps({ externalSitemaps: ['httpx://a.com/sitemap.xml'] })
		).toThrow(/must use http: or https:/);
	});
});

// =============================================================================
// resolveStaticSiteUrl
// =============================================================================

describe('resolveStaticSiteUrl', () => {
	it('returns null when siteUrl is undefined', () => {
		expect(resolveStaticSiteUrl({})).toBeNull();
	});

	it('returns the siteUrl trimmed of trailing slash', () => {
		expect(resolveStaticSiteUrl({ siteUrl: 'https://a.com/' })).toBe(
			'https://a.com'
		);
	});

	it('preserves siteUrl without trailing slash', () => {
		expect(resolveStaticSiteUrl({ siteUrl: 'https://a.com' })).toBe(
			'https://a.com'
		);
	});

	it('preserves subpath deployments', () => {
		expect(resolveStaticSiteUrl({ siteUrl: 'https://a.com/app/' })).toBe(
			'https://a.com/app'
		);
	});

	it('throws on invalid URL', () => {
		expect(() =>
			resolveStaticSiteUrl({ siteUrl: 'not a url' })
		).toThrow(/is not a valid URL/);
	});
});

// =============================================================================
// enumerateGroups
// =============================================================================

describe('enumerateGroups', () => {
	it('always includes the default group', () => {
		expect([...enumerateGroups({})]).toEqual([DEFAULT_GROUP]);
	});

	it('includes named groups from object pathConfigs', () => {
		const groups = enumerateGroups({
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [] },
				'/docs/[slug]': { group: 'docs', resolve: () => [] }
			}
		});
		expect(groups.has(DEFAULT_GROUP)).toBe(true);
		expect(groups.has('blog')).toBe(true);
		expect(groups.has('docs')).toBe(true);
	});

	it('skips function pathConfigs (they belong to default group)', () => {
		const groups = enumerateGroups({
			paths: { '/blog/[id]': () => [] }
		});
		expect([...groups]).toEqual([DEFAULT_GROUP]);
	});

	it('treats object pathConfig with no group as the default group', () => {
		const groups = enumerateGroups({
			paths: { '/blog/[id]': { resolve: () => [] } } // no group
		});
		expect([...groups]).toEqual([DEFAULT_GROUP]);
	});

	it('deduplicates groups across multiple paths', () => {
		const groups = enumerateGroups({
			paths: {
				'/blog/[id]': { group: 'content', resolve: () => [] },
				'/articles/[slug]': { group: 'content', resolve: () => [] }
			}
		});
		expect([...groups].filter((g) => g === 'content').length).toBe(1);
	});
});

// =============================================================================
// buildEntries
// =============================================================================

describe('buildEntries', () => {
	it('builds an entry for each static route in the default group', async () => {
		const grouped = await buildEntries(
			ctx({ routes: ['/', '/about'] })
		);
		expect(grouped.get(DEFAULT_GROUP)).toEqual([
			{ loc: 'https://example.com/', lastmod: undefined, changefreq: undefined, priority: undefined },
			{ loc: 'https://example.com/about', lastmod: undefined, changefreq: undefined, priority: undefined }
		]);
	});

	it('runs resolvers for dynamic routes', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/blog/[id]'],
				config: {
					paths: {
						'/blog/[id]': () => [
							{ params: { id: '1' } },
							{ params: { id: '2' } }
						]
					}
				}
			})
		);
		const entries = grouped.get(DEFAULT_GROUP) ?? [];
		expect(entries.map((e) => e.loc)).toEqual([
			'https://example.com/blog/1',
			'https://example.com/blog/2'
		]);
	});

	// =========================================================================
	// Custom paths — entries in `paths` whose keys aren't discovered routes
	// =========================================================================

	it('emits a static custom URL via paths (key not in routes)', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: [], // no discovered routes
				config: { paths: { '/legacy/landing': { group: 'marketing' } } }
			})
		);
		const locs = (grouped.get('marketing') ?? []).map((e) => e.loc);
		expect(locs).toEqual(['https://example.com/legacy/landing']);
	});

	it('emits a custom static URL with a bare {} (default group)', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: [],
				config: { paths: { '/legacy/landing': {} } }
			})
		);
		expect(grouped.get(DEFAULT_GROUP)?.map((e) => e.loc)).toEqual([
			'https://example.com/legacy/landing'
		]);
	});

	it('emits a dynamic custom URL via paths with a resolver', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: [],
				config: {
					paths: {
						'/external/[slug]': () => [
							{ params: { slug: 'a' } },
							{ params: { slug: 'b' } }
						]
					}
				}
			})
		);
		expect(grouped.get(DEFAULT_GROUP)?.map((e) => e.loc)).toEqual([
			'https://example.com/external/a',
			'https://example.com/external/b'
		]);
	});

	it('mixes discovered routes and custom paths in the same build', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/about'],
				config: {
					paths: {
						'/legacy': { group: 'marketing' },
						'/external/[id]': () => [{ params: { id: '1' } }]
					}
				}
			})
		);
		const all = [
			...(grouped.get(DEFAULT_GROUP) ?? []),
			...(grouped.get('marketing') ?? [])
		].map((e) => e.loc);
		expect(all).toContain('https://example.com/about');
		expect(all).toContain('https://example.com/legacy');
		expect(all).toContain('https://example.com/external/1');
	});

	it('applies i18n expansion to custom paths', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://x',
				config: {
					i18n: { mode: 'path', defaultLocale: 'en', locales: { en: {}, fr: {} } },
					paths: { '/legacy': {} }
				}
			})
		);
		const locs = (grouped.get(DEFAULT_GROUP) ?? []).map((e) => e.loc);
		expect(locs).toContain('https://x/legacy');
		expect(locs).toContain('https://x/fr/legacy');
	});

	it('skips a custom path that matches an exclude rule', async () => {
		const matchers = resolveExclude({ exclude: ['/admin'] });
		const grouped = await buildEntries(
			ctx({
				routes: [],
				config: { paths: { '/admin/legacy': {} } },
				excludeMatchers: matchers
			})
		);
		expect(grouped.get(DEFAULT_GROUP)).toBeUndefined();
	});

	it('discovered route comes BEFORE custom paths in the output ordering', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/zzz-discovered'],
				config: { paths: { '/aaa-custom': {} } }
			})
		);
		const locs = (grouped.get(DEFAULT_GROUP) ?? []).map((e) => e.loc);
		// Discovered route first even though `/aaa-custom` < `/zzz-discovered`
		expect(locs).toEqual([
			'https://example.com/zzz-discovered',
			'https://example.com/aaa-custom'
		]);
	});

	it('treats { resolve: ... } (no group) as the default group', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/blog/[id]'],
				config: {
					paths: {
						'/blog/[id]': { resolve: () => [{ params: { id: '1' } }] }
					}
				}
			})
		);
		expect(grouped.get(DEFAULT_GROUP)).toHaveLength(1);
	});

	it('puts entries in their declared group', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/blog/[id]'],
				config: {
					paths: {
						'/blog/[id]': {
							group: 'blog',
							resolve: () => [{ params: { id: '1' } }]
						}
					}
				}
			})
		);
		expect(grouped.get('blog')).toHaveLength(1);
		expect(grouped.has(DEFAULT_GROUP)).toBe(false);
	});

	it('applies defaults to entries that do not override them', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/about'],
				config: { defaults: { changefreq: 'monthly', priority: 0.4 } }
			})
		);
		const e = grouped.get(DEFAULT_GROUP)![0];
		expect(e.changefreq).toBe('monthly');
		expect(e.priority).toBe(0.4);
	});

	it('static path meta on the path config emits on the entry', async () => {
		const grouped = await buildEntries(
			ctx({
				config: {
					paths: {
						'/about': {
							group: 'marketing',
							lastmod: '2026-05-09',
							changefreq: 'weekly',
							priority: 0.8
						}
					}
				}
			})
		);
		const e = grouped.get('marketing')![0];
		expect(e.loc).toBe('https://example.com/about');
		// Default precision is 'day' — formatLastmod slices the ISO to YYYY-MM-DD.
		expect(e.lastmod).toBe('2026-05-09');
		expect(e.changefreq).toBe('weekly');
		expect(e.priority).toBe(0.8);
	});

	it('static path meta wins over global defaults', async () => {
		const grouped = await buildEntries(
			ctx({
				config: {
					defaults: { changefreq: 'monthly', priority: 0.4 },
					paths: { '/about': { priority: 0.9 } } // changefreq falls back to defaults
				}
			})
		);
		const e = grouped.get(DEFAULT_GROUP)![0];
		expect(e.priority).toBe(0.9); // overridden
		expect(e.changefreq).toBe('monthly'); // inherited from defaults
	});

	it('dynamic path meta acts as per-path defaults for resolver entries', async () => {
		const grouped = await buildEntries(
			ctx({
				config: {
					defaults: { priority: 0.4 },
					paths: {
						'/blog/[id]': {
							group: 'blog',
							priority: 0.7, // path-level default for the resolver entries
							resolve: () => [
								{ params: { id: 'a' } }, // inherits priority 0.7
								{ params: { id: 'b' }, priority: 1.0 } // own meta wins
							]
						}
					}
				}
			})
		);
		const entries = grouped.get('blog')!;
		expect(entries.find((e) => e.loc.endsWith('/a'))!.priority).toBe(0.7);
		expect(entries.find((e) => e.loc.endsWith('/b'))!.priority).toBe(1.0);
	});

	it('per-entry meta wins over defaults', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/blog/[id]'],
				config: {
					defaults: { changefreq: 'monthly', priority: 0.5 },
					paths: {
						'/blog/[id]': () => [
							{ params: { id: '1' }, changefreq: 'daily', priority: 0.9 }
						]
					}
				}
			})
		);
		const e = grouped.get(DEFAULT_GROUP)![0];
		expect(e.changefreq).toBe('daily');
		expect(e.priority).toBe(0.9);
	});

	it('skips routes excluded by matchers', async () => {
		const matchers = resolveExclude({ exclude: ['/admin'] });
		const grouped = await buildEntries(
			ctx({
				routes: ['/admin', '/admin/users', '/about'],
				excludeMatchers: matchers
			})
		);
		const locs = (grouped.get(DEFAULT_GROUP) ?? []).map((e) => e.loc);
		expect(locs).toEqual(['https://example.com/about']);
	});

	it('does NOT invoke a resolver for an excluded dynamic route', async () => {
		// The resolver for an excluded route is wasted CPU (and may hit a DB).
		// Verify it's never called when the route is excluded.
		const adminResolver = vi.fn(() => [{ params: { id: '1' } }]);
		const matchers = resolveExclude({ exclude: ['/admin'] });
		await buildEntries(
			ctx({
				routes: ['/admin/[id]', '/about'],
				config: {
					paths: {
						'/admin/[id]': { group: 'admin', resolve: adminResolver }
					}
				},
				excludeMatchers: matchers
			})
		);
		expect(adminResolver).not.toHaveBeenCalled();
	});

	it('honors groupsFilter — skips routes not in the requested groups', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/about', '/blog/[id]'],
				config: {
					paths: {
						'/blog/[id]': {
							group: 'blog',
							resolve: () => [{ params: { id: '1' } }]
						}
					}
				}
			}),
			new Set(['blog'])
		);
		expect(grouped.has(DEFAULT_GROUP)).toBe(false);
		expect(grouped.get('blog')).toHaveLength(1);
	});

	it('skips dynamic routes without a resolver', async () => {
		const grouped = await buildEntries(
			ctx({ routes: ['/blog/[id]'] })
		);
		expect(grouped.has(DEFAULT_GROUP)).toBe(false);
	});

	it('skips dynamic routes with group config but no resolver', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/blog/[id]'],
				config: { paths: { '/blog/[id]': { group: 'blog' } } }
			})
		);
		expect(grouped.has('blog')).toBe(false);
	});

	it('runs all resolvers in parallel', async () => {
		const order: string[] = [];
		const tick = (label: string, ms: number) =>
			new Promise<void>((res) =>
				setTimeout(() => {
					order.push(label);
					res();
				}, ms)
			);
		await buildEntries(
			ctx({
				routes: ['/a/[x]', '/b/[x]'],
				config: {
					paths: {
						'/a/[x]': async () => {
							await tick('a', 30);
							return [{ params: { x: '1' } }];
						},
						'/b/[x]': async () => {
							await tick('b', 10);
							return [{ params: { x: '1' } }];
						}
					}
				}
			})
		);
		// b finishes first because the resolvers run concurrently;
		// if they were serial, a would finish first.
		expect(order).toEqual(['b', 'a']);
	});

	it('throws when a resolver returns a non-array', async () => {
		await expect(
			buildEntries(
				ctx({
					routes: ['/blog/[id]'],
					config: { paths: { '/blog/[id]': () => 'oops' as never } }
				})
			)
		).rejects.toThrow(/must return an array of entries/);
	});

	it('throws when a resolver entry is missing params', async () => {
		await expect(
			buildEntries(
				ctx({
					routes: ['/blog/[id]'],
					config: { paths: { '/blog/[id]': () => [{} as never] } }
				})
			)
		).rejects.toThrow(/expected \{ params, \.\.\. \}/);
	});

	it('throws when a resolver returns a param value of undefined (key present but no value)', async () => {
		// `name in item.params` passes (property exists) but fillParams throws
		// because the value is undefined. Exercises the fillParams runtime guard.
		await expect(
			buildEntries(
				ctx({
					routes: ['/blog/[id]'],
					config: {
						paths: {
							'/blog/[id]': () => [
								{ params: { id: undefined as never } }
							]
						}
					}
				})
			)
		).rejects.toThrow(/missing param "id"/);
	});

	it('throws when a resolver returns a param value of null', async () => {
		await expect(
			buildEntries(
				ctx({
					routes: ['/blog/[id]'],
					config: {
						paths: {
							'/blog/[id]': () => [
								{ params: { id: null as never } }
							]
						}
					}
				})
			)
		).rejects.toThrow(/missing param "id"/);
	});

	it('throws when a resolver entry omits a required param', async () => {
		await expect(
			buildEntries(
				ctx({
					routes: ['/blog/[id]/[slug]'],
					config: {
						paths: {
							'/blog/[id]/[slug]': () => [
								{ params: { id: '1' } as never }
							]
						}
					}
				})
			)
		).rejects.toThrow(/missing param "slug"/);
	});

	it('URL-encodes param values', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/post/[slug]'],
				config: {
					paths: {
						'/post/[slug]': () => [{ params: { slug: 'hello world & more' } }]
					}
				}
			})
		);
		expect(grouped.get(DEFAULT_GROUP)![0].loc).toBe(
			'https://example.com/post/hello%20world%20%26%20more'
		);
	});

	it('preserves slashes in rest params while encoding each segment', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/help/[...path]'],
				config: {
					paths: {
						'/help/[...path]': () => [
							{ params: { path: 'getting started/install & setup' } }
						]
					}
				}
			})
		);
		expect(grouped.get(DEFAULT_GROUP)![0].loc).toBe(
			'https://example.com/help/getting%20started/install%20%26%20setup'
		);
	});

	it('strips matcher annotations from params (e.g. [id=int])', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/x/[id=int]'],
				config: {
					paths: {
						'/x/[id=int]': () => [{ params: { id: '42' } }]
					}
				}
			})
		);
		expect(grouped.get(DEFAULT_GROUP)![0].loc).toBe(
			'https://example.com/x/42'
		);
	});

	it('validates priority is in [0, 1]', async () => {
		await expect(
			buildEntries(
				ctx({
					routes: ['/a'],
					config: { defaults: { priority: 1.5 } }
				})
			)
		).rejects.toThrow(/Invalid priority/);
	});

	it('validates lastmod parses to a real date', async () => {
		await expect(
			buildEntries(
				ctx({
					routes: ['/a'],
					config: { defaults: { lastmod: 'not a date' } }
				})
			)
		).rejects.toThrow(/Invalid lastmod/);
	});

	it('normalizes lastmod Date to the configured precision (default: day)', async () => {
		const grouped = await buildEntries(
			ctx({
				routes: ['/a'],
				config: { defaults: { lastmod: new Date('2024-01-01T12:34:56Z') } }
			})
		);
		expect(grouped.get(DEFAULT_GROUP)![0].lastmod).toBe('2024-01-01');
	});

	it('emits full ISO timestamp when lastmodPrecision is "full"', async () => {
		const grouped = await buildEntries({
			...ctx({
				routes: ['/a'],
				config: {
					lastmodPrecision: 'full',
					defaults: { lastmod: new Date('2024-01-01T12:34:56Z') }
				}
			}),
			lastmodPrecision: 'full'
		});
		expect(grouped.get(DEFAULT_GROUP)![0].lastmod).toBe('2024-01-01T12:34:56.000Z');
	});
});

// =============================================================================
// buildEntries — i18n expansion
// =============================================================================

describe('buildEntries — i18n', () => {
	const i18nPath = {
		mode: 'path' as const,
		defaultLocale: 'en',
		locales: { en: {}, fr: {}, de: {} }
	};

	it('does not expand when no i18n is configured', async () => {
		const grouped = await buildEntries(
			ctx({ siteUrl: 'https://x', routes: ['/about'] })
		);
		expect(grouped.get(DEFAULT_GROUP)).toHaveLength(1);
	});

	it('does not expand in cookie mode', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://x',
				routes: ['/about'],
				config: { i18n: { mode: 'cookie', locales: { en: {}, fr: {} } } }
			})
		);
		expect(grouped.get(DEFAULT_GROUP)).toHaveLength(1);
	});

	it('does not expand when locales is empty', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://x',
				routes: ['/about'],
				config: { i18n: { mode: 'path', locales: {} } }
			})
		);
		expect(grouped.get(DEFAULT_GROUP)).toHaveLength(1);
	});

	it('path mode: emits one URL per locale, default unprefixed', async () => {
		const grouped = await buildEntries(
			ctx({ siteUrl: 'https://x', routes: ['/about'], config: { i18n: i18nPath } })
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs).toContain('https://x/about');
		expect(locs).toContain('https://x/fr/about');
		expect(locs).toContain('https://x/de/about');
		expect(locs).toHaveLength(3);
	});

	it('path mode: handles the root path correctly (no double slash)', async () => {
		const grouped = await buildEntries(
			ctx({ siteUrl: 'https://x', routes: ['/'], config: { i18n: i18nPath } })
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs).toContain('https://x/');
		expect(locs).toContain('https://x/fr');
		expect(locs).toContain('https://x/de');
	});

	it('domain mode: replaces host per locale', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://en.example.com',
				routes: ['/about'],
				config: {
					i18n: {
						mode: 'domain',
						defaultLocale: 'en',
						locales: {
							en: { domains: ['en.example.com'] },
							fr: { domains: ['fr.example.com'] }
						}
					}
				}
			})
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs).toContain('https://en.example.com/about');
		expect(locs).toContain('https://fr.example.com/about');
	});

	it('domain mode: accepts full URLs with protocol and port', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://en.example.com',
				routes: ['/'],
				config: {
					i18n: {
						mode: 'domain',
						defaultLocale: 'en',
						locales: {
							en: { domains: ['en.example.com'] },
							fr: { domains: ['http://fr.example.com:8080'] }
						}
					}
				}
			})
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs.some((l) => l.startsWith('http://fr.example.com:8080'))).toBe(true);
	});

	it('domain mode: emits the default-locale entry as-is when default itself has no domain', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://example.com',
				routes: ['/about'],
				config: {
					i18n: {
						mode: 'domain',
						defaultLocale: 'en',
						locales: {
							en: {}, // default with no domain
							fr: { domains: ['fr.example.com'] }
						}
					}
				}
			})
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs).toContain('https://example.com/about');
		expect(locs).toContain('https://fr.example.com/about');
	});

	it('domain mode: skips locale with no domain (except default)', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://en.example.com',
				routes: ['/about'],
				config: {
					i18n: {
						mode: 'domain',
						defaultLocale: 'en',
						locales: {
							en: { domains: ['en.example.com'] },
							fr: {} // no domain
						}
					}
				}
			})
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs).toEqual(['https://en.example.com/about']);
	});

	it('domain mode: a domain string with an explicit port is preserved', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://en.example.com',
				routes: ['/about'],
				config: {
					i18n: {
						mode: 'domain',
						defaultLocale: 'en',
						locales: {
							en: { domains: ['en.example.com'] },
							fr: { domains: ['https://fr.example.com:9000'] }
						}
					}
				}
			})
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs).toContain('https://fr.example.com:9000/about');
	});

	it('domain mode: throws on unparseable domain so misconfig surfaces at build time', async () => {
		await expect(
			buildEntries(
				ctx({
					siteUrl: 'https://en.example.com:8080',
					routes: ['/about'],
					config: {
						i18n: {
							mode: 'domain',
							defaultLocale: 'en',
							locales: {
								en: { domains: ['en.example.com'] },
								fr: { domains: ['foo bar'] }
							}
						}
					}
				})
			)
		).rejects.toThrow();
	});

	it('domain mode: bare hostname (no scheme) gets default https + no port', async () => {
		const grouped = await buildEntries(
			ctx({
				siteUrl: 'https://en.example.com:8080',
				routes: ['/about'],
				config: {
					i18n: {
						mode: 'domain',
						defaultLocale: 'en',
						locales: {
							en: { domains: ['en.example.com'] },
							fr: { domains: ['fr.example.com'] }
						}
					}
				}
			})
		);
		const locs = grouped.get(DEFAULT_GROUP)!.map((e) => e.loc);
		expect(locs.some((l) => l === 'https://fr.example.com/about')).toBe(true);
	});
});

// =============================================================================
// SitemapStore
// =============================================================================

describe('SitemapStore', () => {
	const siteUrl = 'https://example.com';

	const makeBuild = (perGroup: Record<string, Array<{ loc: string }>>) =>
		async (groups: Set<string>) => {
			const out = new Map<string, Array<{ loc: string; lastmod?: string; changefreq?: never; priority?: number }>>();
			for (const g of groups) {
				if (perGroup[g]) out.set(g, perGroup[g]);
			}
			return out as never;
		};

	it('exposes ttl', () => {
		const s = new SitemapStore({ ttl: 99 });
		expect(s.ttl).toBe(99);
	});

	it('uses default TTL when none supplied', () => {
		const s = new SitemapStore();
		expect(s.ttl).toBe(60 * 60);
	});

	describe('getMeta', () => {
		it('rebuilds on first call (cold)', async () => {
			const s = new SitemapStore();
			const build = makeBuild({ '': [{ loc: 'https://x/' }] });
			const meta = await s.getMeta('', siteUrl, build, 50);
			expect(meta.count).toBe(1);
			expect(meta.siteUrl).toBe(siteUrl);
			expect(meta.version).not.toBe('');
		});

		it('returns memo on subsequent calls within META_MEMO_MS', async () => {
			const s = new SitemapStore();
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));
			const m1 = await s.getMeta('', siteUrl, buildSpy, 50);
			const m2 = await s.getMeta('', siteUrl, buildSpy, 50);
			expect(buildSpy).toHaveBeenCalledTimes(1);
			expect(m1).toBe(m2);
		});

		it('refreshes from storage after the in-process memo TTL (5s) elapses', async () => {
			// Design: in-process memo has a short freshness window (META_MEMO_MS,
			// 5s). After it expires, we re-read from the adapter even if we'd
			// otherwise serve from memo. Verifies the memo TTL is honored.
			const adapter = makeMemoryAdapter();
			const s = new SitemapStore({ adapter });
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));

			// Use fake timers around the memo-window check
			vi.useFakeTimers();
			try {
				await s.getMeta('', siteUrl, buildSpy, 50);
				expect(buildSpy).toHaveBeenCalledTimes(1);

				// Within memo window — no adapter read, no rebuild
				const adapterGetBefore = vi.spyOn(adapter, 'get');
				adapterGetBefore.mockClear();
				await s.getMeta('', siteUrl, buildSpy, 50);
				expect(adapterGetBefore).not.toHaveBeenCalled();
				expect(buildSpy).toHaveBeenCalledTimes(1);

				// Advance past the memo TTL — next call must re-read from adapter
				// (the adapter still has the fresh meta, so no rebuild needed)
				vi.advanceTimersByTime(5_001);
				await s.getMeta('', siteUrl, buildSpy, 50);
				expect(adapterGetBefore).toHaveBeenCalled();
				expect(buildSpy).toHaveBeenCalledTimes(1); // still no rebuild (adapter fresh)
				adapterGetBefore.mockRestore();
			} finally {
				vi.useRealTimers();
			}
		});

		it('rebuilds when siteUrl changes (preview-deploy guard)', async () => {
			const s = new SitemapStore();
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));
			await s.getMeta('', 'https://prod.com', buildSpy, 50);
			await s.getMeta('', 'https://preview.com', buildSpy, 50);
			expect(buildSpy).toHaveBeenCalledTimes(2);
		});

		it('uses adapter cache when present', async () => {
			const adapter = makeMemoryAdapter();
			const s = new SitemapStore({ adapter });
			const build = makeBuild({ '': [{ loc: 'https://x/' }] });
			await s.getMeta('', siteUrl, build, 50);
			expect(adapter.store.get('meta')).toBeDefined();
		});

		it('falls through to rebuild when adapter has tombstone (empty version)', async () => {
			const adapter = makeMemoryAdapter();
			adapter.store.set('meta', {
				siteUrl,
				expiresAt: Date.now() + 10000,
				lastBuilt: 0,
				version: '',
				count: 0
			});
			const s = new SitemapStore({ adapter });
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));
			const meta = await s.getMeta('', siteUrl, buildSpy, 50);
			expect(buildSpy).toHaveBeenCalled();
			expect(meta.version).not.toBe('');
		});

		it('rebuilds when cached meta is expired', async () => {
			const adapter = makeMemoryAdapter();
			adapter.store.set('meta', {
				siteUrl,
				expiresAt: Date.now() - 1, // expired
				lastBuilt: 0,
				version: 'old',
				count: 1
			});
			const s = new SitemapStore({ adapter });
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));
			const meta = await s.getMeta('', siteUrl, buildSpy, 50);
			expect(buildSpy).toHaveBeenCalled();
			expect(meta.version).not.toBe('old');
		});

		it('uses different cache keys for default vs named groups', async () => {
			const adapter = makeMemoryAdapter();
			const s = new SitemapStore({ adapter });
			await s.getMeta(
				'',
				siteUrl,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			await s.getMeta(
				'blog',
				siteUrl,
				makeBuild({ blog: [{ loc: 'https://x/blog' }] }),
				50
			);
			expect(adapter.store.has('meta')).toBe(true);
			expect(adapter.store.has('meta:blog')).toBe(true);
		});
	});

	describe('rebuild dedup', () => {
		it('coalesces concurrent calls into one rebuild per group', async () => {
			const s = new SitemapStore();
			const buildSpy = vi.fn(async (groups: Set<string>) => {
				await new Promise((r) => setTimeout(r, 30));
				const m = new Map();
				for (const g of groups) m.set(g, [{ loc: 'https://x/' }]);
				return m as never;
			});
			const [a, b, c] = await Promise.all([
				s.getMeta('', siteUrl, buildSpy, 50),
				s.getMeta('', siteUrl, buildSpy, 50),
				s.getMeta('', siteUrl, buildSpy, 50)
			]);
			expect(buildSpy).toHaveBeenCalledTimes(1);
			expect(a).toBe(b);
			expect(b).toBe(c);
		});

		it('runs separate rebuilds for distinct groups', async () => {
			const s = new SitemapStore();
			const buildSpy = vi.fn(makeBuild({
				'': [{ loc: 'https://x/' }],
				blog: [{ loc: 'https://x/b' }]
			}));
			await Promise.all([
				s.getMeta('', siteUrl, buildSpy, 50),
				s.getMeta('blog', siteUrl, buildSpy, 50)
			]);
			expect(buildSpy).toHaveBeenCalledTimes(2);
		});

		it('clears inflight on rebuild error so the next call retries', async () => {
			const s = new SitemapStore();
			const failing = vi.fn(async () => {
				throw new Error('boom');
			});
			await expect(s.getMeta('', siteUrl, failing as never, 50)).rejects.toThrow(
				'boom'
			);
			// Second call should still call build (not return the failed promise)
			const ok = makeBuild({ '': [{ loc: 'https://x/' }] });
			await expect(s.getMeta('', siteUrl, ok, 50)).resolves.toBeDefined();
			expect(failing).toHaveBeenCalledTimes(1);
		});
	});

	describe('chunking', () => {
		it('produces multiple chunks when entries exceed maxEntries', async () => {
			const s = new SitemapStore();
			const entries = Array.from({ length: 10 }, (_, i) => ({
				loc: `https://x/${i}`
			}));
			const meta = await s.getMeta(
				'',
				siteUrl,
				makeBuild({ '': entries }),
				3
			);
			expect(meta.count).toBe(4); // ceil(10/3)
		});

		it('count=0 for empty groups', async () => {
			const s = new SitemapStore();
			const meta = await s.getMeta('', siteUrl, makeBuild({}), 50);
			expect(meta.count).toBe(0);
		});
	});

	describe('getChunk', () => {
		it('returns a chunk in range', async () => {
			const s = new SitemapStore();
			const { meta, chunk } = await s.getChunk(
				siteUrl,
				'',
				1,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			expect(meta.count).toBe(1);
			expect(chunk?.entries).toHaveLength(1);
		});

		it('returns null chunk when index < 1', async () => {
			const s = new SitemapStore();
			const { chunk } = await s.getChunk(
				siteUrl,
				'',
				0,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			expect(chunk).toBeNull();
		});

		it('returns null chunk when index > count', async () => {
			const s = new SitemapStore();
			const { chunk } = await s.getChunk(
				siteUrl,
				'',
				99,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			expect(chunk).toBeNull();
		});

		it('rebuilds when chunk is missing under the meta version', async () => {
			const adapter = makeMemoryAdapter();
			const s = new SitemapStore({ adapter });
			// Pre-seed: meta says count=1, version=v1, but no matching chunk:v1:1.
			adapter.store.set('meta', {
				siteUrl,
				expiresAt: Date.now() + 10000,
				lastBuilt: Date.now(),
				version: 'v1',
				count: 1
			});
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));
			const { chunk } = await s.getChunk(siteUrl, '', 1, buildSpy, 50);
			expect(chunk).not.toBeNull();
			expect(buildSpy).toHaveBeenCalled();
		});

		it('returns chunk:null after rebuild when index still out of range', async () => {
			const s = new SitemapStore();
			// Build a 1-chunk group; ask for chunk 5
			const { chunk } = await s.getChunk(
				siteUrl,
				'',
				5,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			expect(chunk).toBeNull();
		});
	});

	describe('loadChunk', () => {
		it('rejects out-of-range indexes early', async () => {
			const s = new SitemapStore();
			const meta = await s.getMeta(
				'',
				siteUrl,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			expect(await s.loadChunk(meta, '', 0)).toBeNull();
			expect(await s.loadChunk(meta, '', meta.count + 1)).toBeNull();
		});

		it('returns null when chunk is missing from the cache', async () => {
			const adapter = makeMemoryAdapter();
			const s = new SitemapStore({ adapter });
			const meta = {
				siteUrl,
				expiresAt: Date.now() + 10000,
				lastBuilt: Date.now(),
				version: 'v1',
				count: 1
			};
			expect(await s.loadChunk(meta, '', 1)).toBeNull();
		});

		it('returns null when chunk version mismatches meta version', async () => {
			const adapter = makeMemoryAdapter();
			adapter.store.set('chunk:v1:1', {
				siteUrl,
				group: '',
				index: 1,
				version: 'v0', // mismatched
				entries: []
			});
			const s = new SitemapStore({ adapter });
			const meta = {
				siteUrl,
				expiresAt: Date.now() + 10000,
				lastBuilt: Date.now(),
				version: 'v1',
				count: 1
			};
			expect(await s.loadChunk(meta, '', 1)).toBeNull();
		});

		it('returns null when chunk siteUrl mismatches', async () => {
			const adapter = makeMemoryAdapter();
			adapter.store.set('chunk:v1:1', {
				siteUrl: 'https://different',
				group: '',
				index: 1,
				version: 'v1',
				entries: []
			});
			const s = new SitemapStore({ adapter });
			const meta = {
				siteUrl,
				expiresAt: Date.now() + 10000,
				lastBuilt: Date.now(),
				version: 'v1',
				count: 1
			};
			expect(await s.loadChunk(meta, '', 1)).toBeNull();
		});
	});

	describe('invalidate', () => {
		it('clears in-memory cache for the requested groups', async () => {
			const s = new SitemapStore();
			await s.getMeta(
				'',
				siteUrl,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			await s.invalidate(['']);
			// Spy on the next rebuild
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));
			await s.getMeta('', siteUrl, buildSpy, 50);
			expect(buildSpy).toHaveBeenCalledTimes(1);
		});

		it('writes a tombstone in the adapter (not a delete)', async () => {
			const adapter = makeMemoryAdapter();
			const s = new SitemapStore({ adapter });
			await s.getMeta(
				'',
				siteUrl,
				makeBuild({ '': [{ loc: 'https://x/' }] }),
				50
			);
			await s.invalidate(['']);
			const cached = adapter.store.get('meta') as { version: string };
			expect(cached.version).toBe(''); // tombstone marker
		});

		it('writes tombstones BEFORE clearing the memo (race-window fix)', async () => {
			// Real verification: while invalidate is *awaiting* its tombstone
			// write, a concurrent getMeta must still return the (last known)
			// memo'd value — proving the memo wasn't cleared yet. After the
			// invalidate resolves, the next getMeta must rebuild.
			let blockTombstone = false;
			let releaseTombstone!: () => void;
			const tombstoneWrote = new Promise<void>((res) => {
				releaseTombstone = res;
			});

			const adapter: CacheAdapter = {
				get: () => null,
				set: async (key) => {
					// Only block once we've flipped the switch — lets the seed
					// rebuild (also writes 'meta') complete normally.
					if (blockTombstone && key === 'meta') {
						await tombstoneWrote;
					}
				}
			};
			const s = new SitemapStore({ adapter });
			const buildSpy = vi.fn(makeBuild({ '': [{ loc: 'https://x/' }] }));

			// Seed: rebuild populates memo + writes meta+chunk
			const seeded = await s.getMeta('', siteUrl, buildSpy, 50);
			expect(buildSpy).toHaveBeenCalledTimes(1);

			// Now arm the block — the next 'meta' write (the tombstone) will hang
			blockTombstone = true;

			// Start invalidate but don't await — it'll block on the tombstone write
			const invalidatePromise = s.invalidate(['']);
			// Yield so invalidate enters the adapter.set call
			await new Promise((r) => setTimeout(r, 0));

			// CRITICAL: while invalidate is mid-flight (tombstone not yet landed,
			// memo not yet cleared), a concurrent getMeta must still return the
			// memo'd value — no rebuild, no adapter read.
			const duringInvalidate = await s.getMeta('', siteUrl, buildSpy, 50);
			expect(duringInvalidate).toBe(seeded); // same memo object
			expect(buildSpy).toHaveBeenCalledTimes(1); // no rebuild triggered

			// Release the tombstone write → invalidate completes → memo clears
			releaseTombstone();
			await invalidatePromise;

			// Next getMeta sees no memo, hits the adapter, gets nothing useful
			// (our fake `get` always returns null), triggers a rebuild.
			blockTombstone = false; // let further writes through
			await s.getMeta('', siteUrl, buildSpy, 50);
			expect(buildSpy).toHaveBeenCalledTimes(2);
		});

		it('handles multiple groups in one call', async () => {
			const adapter = makeMemoryAdapter();
			const s = new SitemapStore({ adapter });
			await s.getMeta('', siteUrl, makeBuild({ '': [] }), 50);
			await s.getMeta(
				'blog',
				siteUrl,
				makeBuild({ blog: [{ loc: 'https://x/b' }] }),
				50
			);
			await s.invalidate(['', 'blog']);
			expect((adapter.store.get('meta') as { version: string }).version).toBe('');
			expect((adapter.store.get('meta:blog') as { version: string }).version).toBe('');
		});

		it('handles an empty groups iterable (no-op)', async () => {
			const s = new SitemapStore();
			await expect(s.invalidate([])).resolves.toBeUndefined();
		});
	});

	describe('gcInMemoryOrphans (in-memory adapter only)', () => {
		it('makes old-version chunks unreadable after a rebuild (prevents leak)', async () => {
			// loadChunk reads under a key built from `meta.version`. If we keep a
			// snapshot of the OLD meta and try to load with it after a rebuild,
			// the result must be null — proving the GC removed the orphan chunks
			// from the in-memory adapter. Without GC, the old chunks would still
			// be reachable indefinitely (in-memory map has no TTL).
			const s = new SitemapStore();
			const oldMeta = await s.getMeta(
				'blog',
				siteUrl,
				makeBuild({ blog: [{ loc: 'https://x/a' }, { loc: 'https://x/b' }] }),
				1 // maxEntries=1 → 2 chunks
			);
			expect(oldMeta.count).toBe(2);
			// Sanity: chunks are readable under the current version.
			expect(await s.loadChunk(oldMeta, 'blog', 1)).not.toBeNull();
			expect(await s.loadChunk(oldMeta, 'blog', 2)).not.toBeNull();

			// Invalidate + rebuild with different content → new version
			await s.invalidate(['blog']);
			const newMeta = await s.getMeta(
				'blog',
				siteUrl,
				makeBuild({ blog: [{ loc: 'https://x/c' }] }),
				1
			);
			expect(newMeta.version).not.toBe(oldMeta.version);

			// CRITICAL: reading with the OLD meta now returns null — orphans gone.
			expect(await s.loadChunk(oldMeta, 'blog', 1)).toBeNull();
			expect(await s.loadChunk(oldMeta, 'blog', 2)).toBeNull();
			// The new chunk is reachable under the new version.
			expect(await s.loadChunk(newMeta, 'blog', 1)).not.toBeNull();
		});

		it('leaves other groups untouched when GCing one group', async () => {
			const s = new SitemapStore();
			const blogMeta = await s.getMeta(
				'blog',
				siteUrl,
				makeBuild({ blog: [{ loc: 'https://x/b' }] }),
				50
			);
			const docsMeta = await s.getMeta(
				'docs',
				siteUrl,
				makeBuild({ docs: [{ loc: 'https://x/d' }] }),
				50
			);
			// Rebuild ONLY blog
			await s.invalidate(['blog']);
			await s.getMeta(
				'blog',
				siteUrl,
				makeBuild({ blog: [{ loc: 'https://x/b2' }] }),
				50
			);
			// docs's chunk under its original version must still be readable —
			// blog's GC must not have touched it.
			expect(await s.loadChunk(docsMeta, 'docs', 1)).not.toBeNull();
			// blog's old chunks gone
			expect(await s.loadChunk(blogMeta, 'blog', 1)).toBeNull();
		});
	});
});
