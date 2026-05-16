import type { Handle, RequestEvent } from '@sveltejs/kit';
// Star-import so tests can mutate the mocked module's `base`. handle.ts reads
// it once at handle construction (SvelteKit's `paths.base` is build-time
// constant in production, so this isn't a hot-path concern).
import * as appPaths from '$app/paths';
import {
	SitemapStore,
	buildEntries,
	enumerateGroups,
	formatLastmod,
	resolveBasename,
	resolveCache,
	resolveExclude,
	resolveExternalSitemaps,
	resolveLastmodPrecision,
	resolveMaxEntries,
	resolveStaticSiteUrl,
	validateConfig,
	type GroupedEntries
} from './core.js';
import { renderSitemapIndex, renderUrlset, type SitemapIndexEntry } from './xml.js';
import {
	DEFAULT_GROUP,
	type CachedGroupMeta,
	type LastmodPrecision,
	type SitemapConfig
} from './types.js';

/**
 * Strip SvelteKit's `paths.base` prefix from an incoming pathname. Returns
 * `null` when the request doesn't fall under our base — the handle falls
 * through to the next handler in that case. Empty base is a pass-through.
 *
 * `paths.base` invariant per SvelteKit: starts with `/`, no trailing `/`.
 * Checking `base + '/'` (rather than just `startsWith(base)`) prevents
 * `/myapp-other` from falsely matching `base === '/myapp'`.
 */
function stripBase(pathname: string, base: string): string | null {
	if (!base) return pathname;
	if (pathname === base) return '/';
	if (pathname.startsWith(base + '/')) return pathname.slice(base.length);
	return null;
}

type ChunkRequest = { group: string; index: number };

type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * SvelteKit surfaces the platform's background-task primitive at
 * `event.platform.context.waitUntil` (Cloudflare, Vercel). It keeps the
 * isolate alive until the promise settles — required for an SWR background
 * rebuild to finish *after* the response is sent. On a long-lived Node server
 * there's no such context; the rebuild just runs unawaited and the process
 * keeps it alive.
 */
function getWaitUntil(event: RequestEvent): WaitUntilFn {
	const ctx = (event.platform as { context?: { waitUntil?: WaitUntilFn } } | undefined)?.context;
	if (ctx && typeof ctx.waitUntil === 'function') return ctx.waitUntil.bind(ctx);
	return () => {};
}

function compileSitemapRegex(basename: string): RegExp {
	// /{basename}.xml                  → index
	// /{basename}-1.xml                → default group, chunk 1
	// /{basename}-blog-1.xml           → blog group, chunk 1
	return new RegExp(`^\\/${basename}(?:-([a-z][\\w-]*?))?(?:-(\\d+))?\\.xml$`);
}

function parseSitemapPath(re: RegExp, pathname: string): ChunkRequest | 'index' | null {
	const match = re.exec(pathname);
	if (!match) return null;
	if (!match[1] && !match[2]) return 'index';
	if (match[2]) {
		return {
			group: match[1] ?? DEFAULT_GROUP,
			index: Number(match[2])
		};
	}
	// `/{basename}-blog.xml` (no index) — currently unsupported; treat as miss.
	return null;
}

function chunkUrl(siteUrl: string, basename: string, group: string, index: number): string {
	return group === DEFAULT_GROUP
		? `${siteUrl}/${basename}-${index}.xml`
		: `${siteUrl}/${basename}-${group}-${index}.xml`;
}

/**
 * Build the sitemap-index entries from per-group metas. Default group's chunks
 * come first (preserving the original numeric layout), then named groups in
 * alphabetical order, then external sitemaps.
 *
 * Each chunk's `lastmod` is `max(entry.lastmod)` for the entries it contains,
 * so a chunk's index entry only advances when its content actually changes —
 * crawlers can skip refetching otherwise. Falls back to the group's `lastBuilt`
 * when no entry in the chunk has a lastmod (and so for legacy cached metas
 * that pre-date the per-chunk field). External sitemaps have no known lastmod
 * — emitted without one.
 */
function listAllChunkEntries(
	siteUrl: string,
	basename: string,
	metas: Map<string, CachedGroupMeta>,
	externalSitemaps: string[],
	precision: LastmodPrecision
): SitemapIndexEntry[] {
	const entries: SitemapIndexEntry[] = [];
	const pushGroup = (group: string, meta: CachedGroupMeta): void => {
		for (let i = 1; i <= meta.count; i++) {
			const chunkLastmodMs = meta.chunkLastmods?.[i - 1];
			const ms = chunkLastmodMs && chunkLastmodMs > 0 ? chunkLastmodMs : meta.lastBuilt;
			entries.push({
				loc: chunkUrl(siteUrl, basename, group, i),
				lastmod: formatLastmod(new Date(ms), precision)
			});
		}
	};

	const defaultMeta = metas.get(DEFAULT_GROUP);
	if (defaultMeta) pushGroup(DEFAULT_GROUP, defaultMeta);

	const named = [...metas.entries()]
		.filter(([g]) => g !== DEFAULT_GROUP)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	for (const [group, meta] of named) pushGroup(group, meta);

	for (const loc of externalSitemaps) entries.push({ loc });
	return entries;
}

function totalChunkCount(metas: Map<string, CachedGroupMeta>): number {
	let total = 0;
	for (const meta of metas.values()) total += meta.count;
	return total;
}

function newestLastBuilt(metas: Map<string, CachedGroupMeta>): number {
	let newest = 0;
	for (const meta of metas.values()) {
		if (meta.lastBuilt > newest) newest = meta.lastBuilt;
	}
	return newest;
}

export type SitemapHandle = Handle & {
	/**
	 * Wipe the cache. Pass a group name to invalidate just that group; omit to
	 * wipe everything. Call from a CMS webhook, post-deploy hook, or admin
	 * endpoint after content changes.
	 */
	invalidate: (group?: string) => Promise<void>;
	/**
	 * Proactively rebuild the cache — run every resolver, write fresh chunks and
	 * meta — without waiting for a request. Where `invalidate()` only marks the
	 * cache stale and lets the next request pay the rebuild cost, `rebuild()`
	 * does the work itself, so requests afterwards hit a warm cache.
	 *
	 * Intended for a scheduled job (cron) so slow resolvers never block a
	 * request. It runs without a request context, so it can't infer the origin:
	 * set `config.siteUrl`, or pass `{ siteUrl }`. Pass `{ group }` to rebuild a
	 * single group. Rejects with an `AggregateError` if any group's resolvers
	 * throw — groups that succeeded are still committed.
	 *
	 * Only meaningful with an external cache adapter: the in-process cache isn't
	 * shared across serverless instances, so warming it from a cron job wouldn't
	 * reach the instances serving requests.
	 */
	rebuild: (options?: { siteUrl?: string; group?: string }) => Promise<void>;
};

export function createSitemapHandle(config: SitemapConfig = {}): SitemapHandle {
	// Resolve all config-derived values once at startup. Misconfiguration fails
	// here, not at first request; resolveMaxEntries' clamp warning fires once;
	// missing-resolver warnings fire once. `resolveExclude` runs first so its
	// compiled matchers are available to validateConfig's
	// "configured-but-excluded" warning.
	const excludeMatchers = resolveExclude(config);
	validateConfig(config, excludeMatchers);
	const { ttl, swr, adapter } = resolveCache(config);
	const basename = resolveBasename(config);
	const maxEntries = resolveMaxEntries(config);
	const externalSitemaps = resolveExternalSitemaps(config);
	const knownGroups = enumerateGroups(config);
	const sitemapRe = compileSitemapRegex(basename);
	const staticSiteUrl = resolveStaticSiteUrl(config);
	const lastmodPrecision = resolveLastmodPrecision(config);
	// SvelteKit's subpath prefix (`kit.paths.base`). Captured once at handle
	// construction — it's a build-time constant in production.
	const base = appPaths.base ?? '';
	const store = new SitemapStore({ ttl, swr, adapter });
	// Cache-control max-age is floored at 60s — very-short TTLs would otherwise
	// thrash CDNs without giving meaningful freshness benefit (the origin
	// rebuild also costs more than the marginal staleness saves).
	const cacheControlSeconds = Math.max(60, ttl);

	// Build closure bound to a resolved siteUrl. The request path and
	// `rebuild()` both need one — keeps the BuildContext shape in one place.
	const makeBuild =
		(siteUrl: string) =>
		(groups: Set<string>): Promise<GroupedEntries> =>
			buildEntries({ siteUrl, base, config, excludeMatchers, lastmodPrecision }, groups);

	// Human-readable known-group list for "unknown group" error messages.
	const describeGroups = (): string =>
		[...knownGroups].map((g) => (g === DEFAULT_GROUP ? '(default)' : g)).join(', ');

	const fn: Handle = async ({ event, resolve }) => {
		// Strip the SvelteKit base prefix before matching. Anything outside
		// our base — including unrelated URLs that just happen to share a
		// prefix like `/myapp-other/page` — falls through.
		const stripped = stripBase(event.url.pathname, base);
		if (stripped === null) return resolve(event);
		const parsed = parseSitemapPath(sitemapRe, stripped);
		if (parsed === null) return resolve(event);

		// Per-entry `<loc>` and chunk URLs both live under siteUrl + base, so
		// fold base into siteUrl once and use that everywhere downstream
		// (cache key, build context, chunk URL builder).
		// `event.url.origin` is always a valid origin string per WHATWG URL —
		// no need to re-parse it. `staticSiteUrl` was validated at startup.
		const siteUrl = (staticSiteUrl ?? event.url.origin) + base;
		const build = makeBuild(siteUrl);

		// SWR: when getMeta/getChunk hands back a meta whose `expiresAt` is in
		// the past, the data was served stale — trigger a background rebuild so
		// the next request gets fresh data. (A past `expiresAt` only happens
		// when `swr` is set; otherwise getMeta rebuilds inline
		// and always returns fresh, so this is a no-op.) `rebuildGroup` dedups
		// via its inflight map, so concurrent stale requests share one rebuild.
		const waitUntil = getWaitUntil(event);
		const revalidateIfStale = (group: string, meta: CachedGroupMeta): void => {
			if (meta.expiresAt > Date.now()) return;
			waitUntil(
				store.rebuildGroup(group, siteUrl, build, maxEntries).then(
					() => {},
					(err) =>
						console.error(
							`[sitemap] background revalidation failed for group "${group}":`,
							err
						)
				)
			);
		};

		if (parsed !== 'index') {
			// Reject unknown groups *before* triggering any cache work.
			// Otherwise `/sitemap-{anything}-1.xml` would force a rebuild and
			// write a count=0 meta to storage on every miss — wasted I/O on
			// honest 404s, and a cache-poisoning footprint on hostile traffic.
			if (!knownGroups.has(parsed.group)) {
				return new Response('Not found', { status: 404 });
			}
			const { meta, chunk } = await store.getChunk(
				siteUrl,
				parsed.group,
				parsed.index,
				build,
				maxEntries
			);
			if (!chunk) return new Response('Not found', { status: 404 });
			revalidateIfStale(parsed.group, meta);
			return xmlResponse(renderUrlset(chunk.entries), cacheControlSeconds, meta.lastBuilt);
		}

		// Index path: read every group's meta in parallel. Each getMeta hits its
		// own memo / KV / rebuild path independently.
		const metaList = await Promise.all(
			[...knownGroups].map(async (group) => {
				const meta = await store.getMeta(group, siteUrl, build, maxEntries);
				return [group, meta] as const;
			})
		);
		const metas = new Map(metaList);

		// Kick a background rebuild for any group that came back stale (covers
		// the default group used by the single-chunk shortcut below too).
		for (const [group, meta] of metas) revalidateIfStale(group, meta);

		// Single chunk in the default group, no externals → render the urlset
		// directly at /{basename}.xml. Otherwise serve a sitemapindex.
		const total = totalChunkCount(metas);
		const defaultMeta = metas.get(DEFAULT_GROUP);
		if (
			externalSitemaps.length === 0 &&
			total === 1 &&
			defaultMeta?.count === 1
		) {
			const { chunk } = await store.getChunk(siteUrl, DEFAULT_GROUP, 1, build, maxEntries);
			return xmlResponse(
				renderUrlset(chunk?.entries ?? []),
				cacheControlSeconds,
				defaultMeta.lastBuilt
			);
		}

		const lastBuilt = newestLastBuilt(metas);
		const indexEntries = listAllChunkEntries(
			siteUrl,
			basename,
			metas,
			externalSitemaps,
			lastmodPrecision
		);
		return xmlResponse(renderSitemapIndex(indexEntries), cacheControlSeconds, lastBuilt);
	};

	return Object.assign(fn, {
		// `async` so a bad-group throw becomes a Promise rejection, not a sync
		// exception — the type signature promises Promise<void>, and callers
		// reasonably use `.catch()` on it.
		invalidate: async (group?: string): Promise<void> => {
			if (group !== undefined && !knownGroups.has(group)) {
				throw new Error(
					`[sitemap] invalidate: unknown group "${group}". Known groups: ${describeGroups()}.`
				);
			}
			await store.invalidate(group !== undefined ? [group] : knownGroups);
		},
		rebuild: async (
			options: { siteUrl?: string; group?: string } = {}
		): Promise<void> => {
			if (options.siteUrl !== undefined) {
				try {
					new URL(options.siteUrl);
				} catch {
					throw new Error(
						`[sitemap] rebuild: siteUrl "${options.siteUrl}" is not a valid URL.`
					);
				}
			}
			const root = options.siteUrl ?? staticSiteUrl;
			if (!root) {
				throw new Error(
					'[sitemap] rebuild() runs without a request, so it cannot infer the ' +
						'origin — set config.siteUrl or pass { siteUrl } to rebuild().'
				);
			}
			if (options.group !== undefined && !knownGroups.has(options.group)) {
				throw new Error(
					`[sitemap] rebuild: unknown group "${options.group}". Known groups: ${describeGroups()}.`
				);
			}
			// Same siteUrl composition as the request path: (origin) + base.
			const siteUrl = root.replace(/\/$/, '') + base;
			const build = makeBuild(siteUrl);
			const targets = options.group !== undefined ? [options.group] : [...knownGroups];
			const results = await Promise.allSettled(
				targets.map((g) => store.rebuildGroup(g, siteUrl, build, maxEntries))
			);
			const rejected = results.filter(
				(r): r is PromiseRejectedResult => r.status === 'rejected'
			);
			if (rejected.length > 0) {
				throw new AggregateError(
					rejected.map((r) => r.reason),
					`[sitemap] rebuild: ${rejected.length}/${targets.length} group(s) failed.`
				);
			}
		}
	});
}

function xmlResponse(body: string, maxAgeSeconds: number, lastBuilt: number): Response {
	const ageSeconds = Math.max(0, Math.floor((Date.now() - lastBuilt) / 1000));
	return new Response(body, {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': `public, max-age=${maxAgeSeconds}`,
			age: String(ageSeconds)
		}
	});
}
