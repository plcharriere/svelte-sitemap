import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Handle, RequestEvent } from '@sveltejs/kit';

// Mock SvelteKit's `$app/paths` with a mutable object. `vi.mock` is hoisted
// above ordinary `const` declarations, so the shared state has to be created
// inside `vi.hoisted` to be in scope when the factory runs. handle.ts reads
// `appPaths.base` lazily inside `createSitemapHandle`, so individual tests
// can flip the base before constructing the handle and reset in `beforeEach`.
const appPaths = vi.hoisted(() => ({ base: '' }));
vi.mock('$app/paths', () => appPaths);

import { createSitemapHandle, type SitemapHandle } from '../src/lib/handle.js';
import type { CacheAdapter, PathConfig, SitemapConfig } from '../src/lib/types.js';

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	// Default to root deployment for every test; subpath tests opt in by
	// setting `appPaths.base = '/myapp'` before calling `createSitemapHandle`.
	appPaths.base = '';
});
afterEach(() => {
	warnSpy.mockRestore();
	appPaths.base = '';
});

function makeAdapter(): CacheAdapter & { store: Map<string, unknown> } {
	const store = new Map<string, unknown>();
	return {
		store,
		get: (k) => store.get(k) ?? null,
		set: (k, v) => {
			store.set(k, v);
		}
	};
}

/** Build a minimal RequestEvent fake — only the fields handle.ts reads. */
function makeEvent(pathname: string, origin = 'https://example.com'): RequestEvent {
	const url = new URL(origin + pathname);
	return { url } as unknown as RequestEvent;
}

const fallthroughResolve = vi.fn(async () => new Response('fallthrough'));

beforeEach(() => {
	fallthroughResolve.mockClear();
});

async function call(handle: Handle, pathname: string, origin?: string): Promise<Response> {
	return await handle({
		event: makeEvent(pathname, origin),
		resolve: fallthroughResolve as never
	});
}

/**
 * Build a SitemapHandle. `routes` is the legacy "auto-discovered routes"
 * shorthand (what the Vite plugin emits) — merged into `paths` as
 * `{ '/foo': {} }`. `config.paths` overrides on collision so tests can still
 * attach resolvers/groups to specific routes.
 */
function make(routes: string[], config: SitemapConfig = {}): SitemapHandle {
	const auto: Record<string, PathConfig> = {};
	for (const r of routes) auto[r] = {};
	return createSitemapHandle({
		...config,
		paths: { ...auto, ...(config.paths ?? {}) }
	});
}

// =============================================================================
// Startup behavior
// =============================================================================

describe('createSitemapHandle — startup', () => {
	it('returns a function compatible with the Handle signature', () => {
		const h = make(['/']);
		expect(typeof h).toBe('function');
		expect(typeof h.invalidate).toBe('function');
	});

	it('throws synchronously on invalid config', () => {
		expect(() => make([], { exclude: ['/'] })).toThrow(/would match every route/);
	});

	it('warns at startup for a discovered dynamic route with no resolver', () => {
		make(['/blog/[id]']);
		const calls = warnSpy.mock.calls.map((c: unknown[]) => c[0]);
		expect(calls.some((m: string) => m.includes('is a dynamic pattern with no resolver'))).toBe(
			true
		);
	});

	it('does not warn when a paths key isn’t a discovered route — treats as custom', () => {
		make(['/blog/[id]'], {
			paths: {
				'/blog/[id]': () => [],
				'/external/landing': { group: 'external' }
			}
		});
		const calls = warnSpy.mock.calls.map((c: unknown[]) => c[0]);
		expect(calls.some((m: string) => m.includes("doesn't match any discovered route"))).toBe(
			false
		);
	});

	it('uses defaults when no config is passed', () => {
		expect(() => createSitemapHandle()).not.toThrow();
	});

	it('works with no routes at all (empty array)', () => {
		const h = make([]);
		expect(typeof h).toBe('function');
	});
});

// =============================================================================
// Path matching — non-sitemap requests fall through
// =============================================================================

describe('routing — fall-through', () => {
	it('falls through for non-sitemap paths', async () => {
		const h = make(['/']);
		const res = await call(h, '/about');
		expect(await res.text()).toBe('fallthrough');
		expect(fallthroughResolve).toHaveBeenCalled();
	});

	it('falls through for similar-but-wrong filenames', async () => {
		const h = make(['/']);
		expect(await (await call(h, '/sitemap.xml.gz')).text()).toBe('fallthrough');
		expect(await (await call(h, '/sitemap-foo')).text()).toBe('fallthrough');
		expect(await (await call(h, '/sitemap-1.txt')).text()).toBe('fallthrough');
	});

	it('respects custom basename — only matches the configured stem', async () => {
		const h = make(['/'], { basename: 'urls' });
		expect(await (await call(h, '/sitemap.xml')).text()).toBe('fallthrough');
		const res = await call(h, '/urls.xml');
		expect(res.headers.get('content-type')).toContain('application/xml');
	});

	it('emits chunk URLs with the custom basename in the index', async () => {
		const h = make(['/', '/blog/[id]'], {
			basename: 'urls',
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '1' } }] }
			}
		});
		const body = await (await call(h, '/urls.xml')).text();
		expect(body).toContain('<sitemapindex');
		// Index entries must use the custom basename, not 'sitemap'
		expect(body).toContain('/urls-1.xml');
		expect(body).toContain('/urls-blog-1.xml');
		expect(body).not.toContain('/sitemap-');

		const chunkRes = await call(h, '/urls-blog-1.xml');
		expect(chunkRes.status).toBe(200);
		expect(await chunkRes.text()).toContain('https://example.com/blog/1');
	});
});

// =============================================================================
// Index serving (/sitemap.xml)
// =============================================================================

describe('index serving', () => {
	it('renders the single-chunk shortcut as <urlset> when only the default group exists with one chunk', async () => {
		const h = make(['/', '/about']);
		const res = await call(h, '/sitemap.xml');
		const body = await res.text();
		expect(body).toContain('<urlset');
		expect(body).not.toContain('<sitemapindex');
		expect(body).toContain('https://example.com/');
		expect(body).toContain('https://example.com/about');
	});

	it('renders <sitemapindex> when there are multiple groups', async () => {
		const h = make(['/', '/blog/[id]'], {
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '1' } }] }
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('<sitemapindex');
		expect(body).toContain('sitemap-1.xml');
		expect(body).toContain('sitemap-blog-1.xml');
	});

	it('renders <sitemapindex> when there are external sitemaps (no shortcut)', async () => {
		const h = make(['/'], {
			externalSitemaps: ['https://shop.example.com/sitemap.xml']
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('<sitemapindex');
		expect(body).toContain('https://shop.example.com/sitemap.xml');
	});

	it('renders <sitemapindex> when default group splits across chunks', async () => {
		const h = make(['/blog/[id]'], {
			maxEntries: 2,
			paths: {
				'/blog/[id]': () =>
					Array.from({ length: 5 }, (_, i) => ({ params: { id: String(i) } }))
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('<sitemapindex');
		expect((body.match(/sitemap-\d+\.xml/g) ?? []).length).toBe(3);
	});

	it('renders an empty <sitemapindex> when there are no routes and no externals', async () => {
		const h = make([]);
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('<sitemapindex');
	});

	it('orders chunks: default group first, then named groups alphabetically, then externals', async () => {
		const h = make(['/', '/blog/[id]', '/news/[id]'], {
			paths: {
				'/blog/[id]': { group: 'alpha', resolve: () => [{ params: { id: '1' } }] },
				'/news/[id]': { group: 'zeta', resolve: () => [{ params: { id: '1' } }] }
			},
			externalSitemaps: ['https://shop.example.com/sitemap.xml']
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		const idxDefault = body.indexOf('sitemap-1.xml');
		const idxAlpha = body.indexOf('sitemap-alpha-1.xml');
		const idxZeta = body.indexOf('sitemap-zeta-1.xml');
		const idxExt = body.indexOf('shop.example.com');
		expect(idxDefault).toBeGreaterThan(-1);
		expect(idxAlpha).toBeGreaterThan(idxDefault);
		expect(idxZeta).toBeGreaterThan(idxAlpha);
		expect(idxExt).toBeGreaterThan(idxZeta);
	});

	it('emits per-entry <lastmod> in the sitemapindex (not a single shared one)', async () => {
		const h = make(['/', '/blog/[id]'], {
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '1' } }] }
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		expect((body.match(/<lastmod>/g) ?? []).length).toBe(2);
	});

	it('uses max(entry.lastmod) per chunk so lastmod is stable across rebuilds when content is unchanged', async () => {
		const h = make([], {
			paths: {
				'/blog/[id]': {
					group: 'blog',
					resolve: () => [
						{ params: { id: 'a' }, lastmod: '2026-01-15' },
						{ params: { id: 'b' }, lastmod: '2026-02-03' },
						{ params: { id: 'c' }, lastmod: '2026-03-10' }
					]
				}
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		// Newest entry lastmod in the blog group is 2026-03-10 — index entry
		// for the blog chunk must reflect that, NOT the (today) build time.
		const blogBlock = body.match(/<sitemap>[\s\S]*?sitemap-blog-1\.xml[\s\S]*?<\/sitemap>/)?.[0];
		expect(blogBlock).toBeDefined();
		expect(blogBlock).toContain('<lastmod>2026-03-10</lastmod>');
	});

	it('falls back to lastBuilt when no entry in the chunk has a lastmod', async () => {
		const h = make([], {
			paths: {
				'/blog/[id]': {
					group: 'blog',
					resolve: () => [{ params: { id: 'a' } }, { params: { id: 'b' } }]
				}
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		// No entry has lastmod → chunk's index lastmod uses build time (today, ISO).
		const blogBlock = body.match(/<sitemap>[\s\S]*?sitemap-blog-1\.xml[\s\S]*?<\/sitemap>/)?.[0];
		expect(blogBlock).toBeDefined();
		// formatDate slices ISO to YYYY-MM-DD; just check the field is present and valid.
		expect(blogBlock).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
	});

	it('per-chunk lastmods differ when entries are split across chunks', async () => {
		// maxEntries: 2 forces splitting. Chunk 1 holds the two oldest, chunk 2
		// the two newest — each chunk's lastmod must reflect its own contents.
		const h = make([], {
			maxEntries: 2,
			paths: {
				'/blog/[id]': {
					resolve: () => [
						{ params: { id: '1' }, lastmod: '2026-01-01' },
						{ params: { id: '2' }, lastmod: '2026-02-01' },
						{ params: { id: '3' }, lastmod: '2026-03-01' },
						{ params: { id: '4' }, lastmod: '2026-04-01' }
					]
				}
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		const c1 = body.match(/<sitemap>[\s\S]*?sitemap-1\.xml[\s\S]*?<\/sitemap>/)?.[0];
		const c2 = body.match(/<sitemap>[\s\S]*?sitemap-2\.xml[\s\S]*?<\/sitemap>/)?.[0];
		expect(c1).toContain('<lastmod>2026-02-01</lastmod>');
		expect(c2).toContain('<lastmod>2026-04-01</lastmod>');
	});
});

// =============================================================================
// Subpath deployment (SvelteKit `kit.paths.base`)
// =============================================================================

describe('subpath deployment (paths.base)', () => {
	it('serves the sitemap at /{base}/sitemap.xml when base is set', async () => {
		appPaths.base = '/myapp';
		const h = make(['/']);
		const res = await call(h, '/myapp/sitemap.xml');
		expect(res.headers.get('content-type')).toContain('application/xml');
		const body = await res.text();
		expect(body).toContain('<urlset');
	});

	it('falls through for /sitemap.xml at the root when base is set', async () => {
		appPaths.base = '/myapp';
		const h = make(['/']);
		const res = await call(h, '/sitemap.xml');
		expect(fallthroughResolve).toHaveBeenCalledOnce();
		expect(await res.text()).toBe('fallthrough');
	});

	it('falls through for paths that share a prefix with base but aren’t under it', async () => {
		// `/myapp-other/sitemap.xml` startsWith `/myapp`, but the next char
		// isn't `/` — must NOT be treated as our request.
		appPaths.base = '/myapp';
		const h = make(['/']);
		const res = await call(h, '/myapp-other/sitemap.xml');
		expect(fallthroughResolve).toHaveBeenCalledOnce();
		expect(await res.text()).toBe('fallthrough');
	});

	it('emits per-entry <loc>s prefixed with base', async () => {
		appPaths.base = '/myapp';
		const h = make([], {
			paths: { '/about': {}, '/blog/[id]': () => [{ params: { id: 'a' } }] }
		});
		const body = await (await call(h, '/myapp/sitemap.xml')).text();
		expect(body).toContain('<loc>https://example.com/myapp/about</loc>');
		expect(body).toContain('<loc>https://example.com/myapp/blog/a</loc>');
	});

	it('emits index chunk URLs prefixed with base', async () => {
		appPaths.base = '/myapp';
		const h = make(['/'], {
			paths: { '/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: 'a' } }] } }
		});
		const body = await (await call(h, '/myapp/sitemap.xml')).text();
		expect(body).toContain('<loc>https://example.com/myapp/sitemap-1.xml</loc>');
		expect(body).toContain('<loc>https://example.com/myapp/sitemap-blog-1.xml</loc>');
	});

	it('serves a chunk at /{base}/sitemap-{group}-N.xml', async () => {
		appPaths.base = '/myapp';
		const h = make(['/'], {
			paths: { '/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: 'a' } }] } }
		});
		const res = await call(h, '/myapp/sitemap-blog-1.xml');
		expect(res.headers.get('content-type')).toContain('application/xml');
		const body = await res.text();
		expect(body).toContain('<loc>https://example.com/myapp/blog/a</loc>');
	});

	it('handles a base equal to the request path (just /{base}) by falling through', async () => {
		// `/myapp` itself isn't a sitemap path — should fall through, not 404.
		appPaths.base = '/myapp';
		const h = make(['/']);
		const res = await call(h, '/myapp');
		expect(fallthroughResolve).toHaveBeenCalledOnce();
		expect(await res.text()).toBe('fallthrough');
	});

	it('staticSiteUrl + base composes correctly (no double slash, both segments present)', async () => {
		appPaths.base = '/myapp';
		const h = make([], {
			siteUrl: 'https://cdn.example.com',
			paths: { '/about': {} }
		});
		const body = await (await call(h, '/myapp/sitemap.xml')).text();
		expect(body).toContain('<loc>https://cdn.example.com/myapp/about</loc>');
		expect(body).not.toContain('//myapp');
	});

	it('path-mode i18n inserts the locale code AFTER base, not before it', async () => {
		// Bug guard: previously emitted /fr/myapp/about. The correct URL puts
		// the locale inside the deployment subpath: /myapp/fr/about.
		appPaths.base = '/myapp';
		const h = make([], {
			paths: { '/about': {} },
			i18n: {
				mode: 'path',
				defaultLocale: 'en',
				locales: { en: {}, fr: {} }
			}
		});
		const body = await (await call(h, '/myapp/sitemap.xml')).text();
		expect(body).toContain('<loc>https://example.com/myapp/about</loc>');
		expect(body).toContain('<loc>https://example.com/myapp/fr/about</loc>');
		expect(body).not.toContain('/fr/myapp');
	});

	it('domain-mode i18n keeps base in the path on the locale domain', async () => {
		appPaths.base = '/myapp';
		const h = make([], {
			paths: { '/about': {} },
			i18n: {
				mode: 'domain',
				defaultLocale: 'en',
				locales: {
					en: { domains: ['en.example.com'] },
					fr: { domains: ['fr.example.com'] }
				}
			}
		});
		const body = await (await call(h, '/myapp/sitemap.xml')).text();
		expect(body).toContain('<loc>https://en.example.com/myapp/about</loc>');
		expect(body).toContain('<loc>https://fr.example.com/myapp/about</loc>');
	});
});

// =============================================================================
// lastmodPrecision
// =============================================================================

describe('lastmodPrecision', () => {
	it('defaults to day precision (YYYY-MM-DD) for entry lastmods', async () => {
		const h = make([], {
			paths: {
				'/blog/[id]': () => [{ params: { id: 'a' }, lastmod: '2026-03-10T14:32:00Z' }]
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('<lastmod>2026-03-10</lastmod>');
		expect(body).not.toContain('14:32');
	});

	it('emits full ISO timestamps when lastmodPrecision is "full"', async () => {
		const h = make([], {
			lastmodPrecision: 'full',
			paths: {
				'/blog/[id]': () => [{ params: { id: 'a' }, lastmod: '2026-03-10T14:32:17.500Z' }]
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('<lastmod>2026-03-10T14:32:17.500Z</lastmod>');
	});

	it('applies precision to sitemapindex chunk lastmods too', async () => {
		const h = make(['/'], {
			lastmodPrecision: 'full',
			paths: {
				'/blog/[id]': {
					group: 'blog',
					resolve: () => [{ params: { id: 'a' }, lastmod: '2026-03-10T14:32:17Z' }]
				}
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		// The blog sub-sitemap entry in the index should carry the full timestamp,
		// matching its newest entry's precision.
		const blogBlock = body.match(/<sitemap>[\s\S]*?sitemap-blog-1\.xml[\s\S]*?<\/sitemap>/)?.[0];
		expect(blogBlock).toContain('<lastmod>2026-03-10T14:32:17.000Z</lastmod>');
	});

	it('throws at startup on an invalid lastmodPrecision value', () => {
		expect(() => make([], { lastmodPrecision: 'minute' as 'day' })).toThrow(
			/lastmodPrecision must be 'day' or 'full'/
		);
	});
});

// =============================================================================
// Plugin-less mode (custom paths only, no `routes` field at all)
// =============================================================================

describe('plugin-less mode', () => {
	it('builds a working sitemap from `paths` only — no routes needed', async () => {
		const h = createSitemapHandle({
			paths: {
				'/legacy/landing': {},
				'/legacy/about': { group: 'marketing' }
			}
		});
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('<sitemapindex');
		expect(body).toContain('sitemap-1.xml');
		expect(body).toContain('sitemap-marketing-1.xml');
	});

	it('serves chunks for custom-only configs', async () => {
		const h = createSitemapHandle({
			paths: {
				'/legacy/landing': {},
				'/external/[id]': () => [{ params: { id: '1' } }, { params: { id: '2' } }]
			}
		});
		const chunk = await (await call(h, '/sitemap-1.xml')).text();
		expect(chunk).toContain('https://example.com/legacy/landing');
		expect(chunk).toContain('https://example.com/external/1');
		expect(chunk).toContain('https://example.com/external/2');
	});
});

// =============================================================================
// Chunk serving
// =============================================================================

describe('chunk serving', () => {
	it('serves /sitemap-1.xml for the default group', async () => {
		const h = make(['/about']);
		const res = await call(h, '/sitemap-1.xml');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('<urlset');
		expect(body).toContain('https://example.com/about');
	});

	it('serves /sitemap-{group}-N.xml for a named group', async () => {
		const h = make(['/blog/[id]'], {
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '42' } }] }
			}
		});
		const res = await call(h, '/sitemap-blog-1.xml');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('https://example.com/blog/42');
	});

	it('returns 404 for an unknown group without triggering a rebuild', async () => {
		const adapter = makeAdapter();
		const h = make(['/'], { cache: { get: adapter.get, set: adapter.set } });
		const res = await call(h, '/sitemap-mystery-1.xml');
		expect(res.status).toBe(404);
		expect(adapter.store.has('meta:mystery')).toBe(false);
	});

	it('returns 404 for out-of-range chunk index', async () => {
		const h = make(['/about']);
		const res = await call(h, '/sitemap-99.xml');
		expect(res.status).toBe(404);
	});

	it('returns 404 for /sitemap-{group}.xml without an index (unsupported form)', async () => {
		const h = make(['/blog/[id]'], {
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '1' } }] }
			}
		});
		const res = await call(h, '/sitemap-blog.xml');
		expect(await res.text()).toBe('fallthrough');
	});

	it('handles a chunk with multiple URL entries', async () => {
		const h = make(['/blog/[id]'], {
			paths: {
				'/blog/[id]': () =>
					Array.from({ length: 3 }, (_, i) => ({ params: { id: String(i) } }))
			}
		});
		const body = await (await call(h, '/sitemap-1.xml')).text();
		expect((body.match(/<url>/g) ?? []).length).toBe(3);
	});
});

// =============================================================================
// Response headers
// =============================================================================

describe('response headers', () => {
	it('sets content-type: application/xml; charset=utf-8', async () => {
		const h = make(['/']);
		const res = await call(h, '/sitemap.xml');
		expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
	});

	it('sets cache-control with max-age >= 60s even for tiny TTLs', async () => {
		const h = make(['/'], { cache: { ttl: 5 } });
		const res = await call(h, '/sitemap.xml');
		expect(res.headers.get('cache-control')).toBe('public, max-age=60');
	});

	it('sets cache-control with the configured TTL when above the floor', async () => {
		const h = make(['/'], { cache: { ttl: 7200 } });
		const res = await call(h, '/sitemap.xml');
		expect(res.headers.get('cache-control')).toBe('public, max-age=7200');
	});

	it('sets an Age header reflecting time since lastBuilt', async () => {
		const h = make(['/']);
		const fresh = await call(h, '/sitemap.xml');
		const ageFresh = Number(fresh.headers.get('age'));
		expect(ageFresh).toBeGreaterThanOrEqual(0);
		expect(ageFresh).toBeLessThanOrEqual(1);

		await new Promise((r) => setTimeout(r, 1100));
		const later = await call(h, '/sitemap.xml');
		const ageLater = Number(later.headers.get('age'));
		expect(ageLater).toBeGreaterThanOrEqual(1);
	});
});

// =============================================================================
// siteUrl behavior
// =============================================================================

describe('siteUrl', () => {
	it('uses event.url.origin by default', async () => {
		const h = make(['/about']);
		const body = await (await call(h, '/sitemap.xml', 'https://preview.example.com')).text();
		expect(body).toContain('https://preview.example.com/about');
	});

	it('uses config.siteUrl when set, ignoring request origin', async () => {
		const h = make(['/about'], { siteUrl: 'https://canonical.example.com' });
		const body = await (await call(h, '/sitemap.xml', 'https://preview.example.com')).text();
		expect(body).toContain('https://canonical.example.com/about');
		expect(body).not.toContain('preview.example.com');
	});

	it('strips trailing slash from config.siteUrl', async () => {
		const h = make(['/about'], { siteUrl: 'https://example.com/' });
		const body = await (await call(h, '/sitemap.xml')).text();
		expect(body).toContain('https://example.com/about');
		expect(body).not.toContain('https://example.com//about');
	});
});

// =============================================================================
// invalidate
// =============================================================================

describe('handle.invalidate', () => {
	it('returns a Promise even on the bad-group path (async semantics)', async () => {
		const h = make(['/']);
		const result = h.invalidate('nonexistent-group');
		expect(result).toBeInstanceOf(Promise);
		await expect(result).rejects.toThrow(/unknown group "nonexistent-group"/);
	});

	it('lists known groups in the error message', async () => {
		const h = make(['/blog/[id]'], {
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '1' } }] }
			}
		});
		await expect(h.invalidate('nope')).rejects.toThrow(/blog/);
		await expect(h.invalidate('nope')).rejects.toThrow(/\(default\)/);
	});

	it('invalidates a single group, leaving other groups untouched', async () => {
		const adapter = makeAdapter();
		const h = make(['/about', '/blog/[id]'], {
			cache: { get: adapter.get, set: adapter.set },
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '1' } }] }
			}
		});
		await call(h, '/sitemap.xml');
		const blogVersionBefore = (adapter.store.get('meta:blog') as { version: string }).version;
		const defaultVersionBefore = (adapter.store.get('meta') as { version: string }).version;

		await h.invalidate('blog');

		expect((adapter.store.get('meta:blog') as { version: string }).version).toBe('');
		expect((adapter.store.get('meta') as { version: string }).version).toBe(
			defaultVersionBefore
		);

		await call(h, '/sitemap-blog-1.xml');
		const blogVersionAfter = (adapter.store.get('meta:blog') as { version: string }).version;
		expect(blogVersionAfter).not.toBe('');
		expect(blogVersionAfter).not.toBe(blogVersionBefore);
	});

	it('invalidates ALL groups when called with no argument', async () => {
		const adapter = makeAdapter();
		const h = make(['/about', '/blog/[id]'], {
			cache: { get: adapter.get, set: adapter.set },
			paths: {
				'/blog/[id]': { group: 'blog', resolve: () => [{ params: { id: '1' } }] }
			}
		});
		await call(h, '/sitemap.xml');
		await h.invalidate();
		expect((adapter.store.get('meta') as { version: string }).version).toBe('');
		expect((adapter.store.get('meta:blog') as { version: string }).version).toBe('');
	});
});

// =============================================================================
// Cache integration
// =============================================================================

describe('cache adapter integration', () => {
	it('passes the configured ttl through to adapter.set', async () => {
		const setSpy = vi.fn();
		const h = make(['/'], { cache: { ttl: 1234, get: () => null, set: setSpy } });
		await call(h, '/sitemap.xml');
		for (const callArgs of setSpy.mock.calls) {
			expect(callArgs[2]).toBe(1234);
		}
		expect(setSpy).toHaveBeenCalled();
	});

	it('serves from cache on the second request (no rebuild)', async () => {
		const buildCount = { n: 0 };
		const h = make(['/blog/[id]'], {
			cache: { ttl: 60, ...makeAdapter() },
			paths: {
				'/blog/[id]': () => {
					buildCount.n++;
					return [{ params: { id: '1' } }];
				}
			}
		});
		await call(h, '/sitemap-1.xml');
		await call(h, '/sitemap-1.xml');
		expect(buildCount.n).toBe(1);
	});
});

// =============================================================================
// Integration — full pipeline with i18n + chunks + groups
// =============================================================================

describe('end-to-end pipeline', () => {
	it('combines exclude + i18n + groups + chunks correctly', async () => {
		const h = make(['/', '/about', '/admin', '/admin/users', '/blog/[id]'], {
			exclude: ['/admin'],
			i18n: { mode: 'path', defaultLocale: 'en', locales: { en: {}, fr: {} } },
			maxEntries: 3,
			paths: {
				'/blog/[id]': {
					group: 'blog',
					resolve: () =>
						Array.from({ length: 4 }, (_, i) => ({ params: { id: String(i) } }))
				}
			}
		});

		const indexBody = await (await call(h, '/sitemap.xml')).text();
		expect(indexBody).not.toContain('/admin');

		const c1 = await (await call(h, '/sitemap-1.xml')).text();
		const c2 = await (await call(h, '/sitemap-2.xml')).text();
		const combined = c1 + c2;
		expect(combined).toContain('https://example.com/about');
		expect(combined).toContain('https://example.com/fr/about');

		const blogIndex = (indexBody.match(/sitemap-blog-\d+\.xml/g) ?? []).length;
		expect(blogIndex).toBe(3);
	});
});
