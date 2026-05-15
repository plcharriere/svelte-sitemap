import type { Handle } from '@sveltejs/kit';
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
};

export function createSitemapHandle(config: SitemapConfig = {}): SitemapHandle {
	// Resolve all config-derived values once at startup. Misconfiguration fails
	// here, not at first request; resolveMaxEntries' clamp warning fires once;
	// missing-resolver warnings fire once. `resolveExclude` runs first so its
	// compiled matchers are available to validateConfig's
	// "configured-but-excluded" warning.
	const excludeMatchers = resolveExclude(config);
	validateConfig(config, excludeMatchers);
	const { ttl, adapter } = resolveCache(config);
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
	const store = new SitemapStore({ ttl, adapter });
	// Cache-control max-age is floored at 60s — very-short TTLs would otherwise
	// thrash CDNs without giving meaningful freshness benefit (the origin
	// rebuild also costs more than the marginal staleness saves).
	const cacheControlSeconds = Math.max(60, ttl);

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
		const build = (groups: Set<string>): Promise<GroupedEntries> =>
			buildEntries({ siteUrl, base, config, excludeMatchers, lastmodPrecision }, groups);

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
					`[sitemap] invalidate: unknown group "${group}". Known groups: ${[...knownGroups]
						.map((g) => (g === DEFAULT_GROUP ? '(default)' : g))
						.join(', ')}.`
				);
			}
			await store.invalidate(group !== undefined ? [group] : knownGroups);
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
