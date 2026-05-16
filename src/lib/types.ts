export type MaybePromise<T> = T | Promise<T>;

export type ChangeFreq =
	| 'always'
	| 'hourly'
	| 'daily'
	| 'weekly'
	| 'monthly'
	| 'yearly'
	| 'never';

export type SitemapEntryMeta = {
	lastmod?: Date | string;
	changefreq?: ChangeFreq;
	priority?: number;
};

/**
 * Output precision for `<lastmod>`:
 * - `'day'` (default) — `YYYY-MM-DD`. Smaller payload, matches what most
 *   static-site generators emit. Two updates the same day produce the same
 *   value, so per-chunk aggregation can't advance within a day.
 * - `'full'` — full ISO timestamp (`YYYY-MM-DDTHH:MM:SS.sssZ`). Every
 *   modification advances the value; useful when crawlers refetch frequently.
 */
export type LastmodPrecision = 'day' | 'full';

export type ResolverEntry<TParams extends Record<string, string> = Record<string, string>> = {
	params: TParams;
} & SitemapEntryMeta;

export type Resolver = () => MaybePromise<ResolverEntry[]>;

export type GroupedResolver = {
	group?: string;
	/**
	 * Required for dynamic routes (e.g. `/blog/[id]`). Omit for static routes —
	 * pass just `{ group: 'blog' }` to put a static page like `/blog` into
	 * the same group as its dynamic children.
	 */
	resolve?: Resolver;
} & SitemapEntryMeta;
//   ^^^^^^^^^^^^^^^^^
// Per-path meta. For STATIC paths, these values are emitted on the entry
// directly. For DYNAMIC paths, they act as per-path defaults — overriding
// `config.defaults`, but overridden by whatever the resolver returns per
// entry. So you can set "all `/blog/[id]` entries default to priority 0.7"
// once at the path level instead of repeating it inside the resolver.

export type PathConfig = Resolver | GroupedResolver;

/**
 * Internal post-validation entry. `lastmod` is normalized to an ISO string at
 * validation time so renderers don't re-parse a Date per entry.
 */
export type ResolvedEntry = {
	loc: string;
	lastmod?: string;
	changefreq?: ChangeFreq;
	priority?: number;
};

export const DEFAULT_GROUP = '';

/**
 * One per group. `meta` for the default group, `meta:{group}` for named groups.
 * Each rebuild generates a fresh `version`; chunks are stored under that version
 * so a failed mid-rebuild can't overwrite chunks the current meta points at.
 */
export type CachedGroupMeta = {
	siteUrl: string;
	expiresAt: number;
	lastBuilt: number;
	version: string;
	count: number;
	/**
	 * Per-chunk newest entry lastmod, in ms-since-epoch, indexed [0..count-1].
	 * `0` means no entry in that chunk had a lastmod — index renderer falls
	 * back to `lastBuilt` so the field always has *some* value. Read by the
	 * index renderer to give crawlers a stable refetch signal: a chunk's
	 * `<lastmod>` only advances when its content actually changes, not on
	 * every cache rebuild.
	 */
	chunkLastmods?: number[];
};

export type CachedChunk = {
	siteUrl: string;
	group: string;
	index: number;
	/** Must match the group meta's version to be considered valid. */
	version: string;
	entries: ResolvedEntry[];
};

export type CacheAdapter = {
	get: (key: string) => MaybePromise<unknown>;
	/**
	 * Persist a value. `ttl` is in **seconds** — pass it straight into your
	 * storage's native expiration (Cloudflare KV's `expirationTtl`, Redis `EX`,
	 * etc.). Note this is the *eviction* TTL: when `swr` is
	 * configured it is `cache.ttl + cache.swr`, so storage
	 * keeps an entry past its freshness deadline — long enough to serve it
	 * stale while a background rebuild runs.
	 */
	set: (key: string, value: unknown, ttl: number) => MaybePromise<void>;
};

/**
 * Cache freshness, optional stale-while-revalidate, and the optional adapter.
 *
 * - `ttl` — freshness window in **seconds**; once it elapses the entry is
 *   stale and due for a rebuild. Default 3600 (1h).
 * - `swr` — extra window in **seconds**. When set, a stale
 *   entry is served *immediately* while a rebuild runs in the background,
 *   instead of the request blocking on the rebuild. Storage keeps the entry
 *   for `ttl + swr`, so a stale copy exists to serve; that
 *   sum is also the longest the sitemap stays servable if rebuilds keep
 *   failing. Omit (or `0`) to disable — a stale entry then blocks on a rebuild.
 *
 * Provide `get`+`set` for an external adapter, or neither for the in-process
 * cache. Supplying just one is rejected.
 */
export type CacheConfig =
	| ({ ttl?: number; swr?: number } & CacheAdapter)
	| { ttl?: number; swr?: number; get?: never; set?: never };

export type LocaleDef = {
	domains?: string[];
};

/**
 * Subset of svelte-translate's I18nConfig that the sitemap needs. Pass the
 * full I18n config from your i18n library directly — extra fields are ignored.
 *
 * - `mode: 'path'` — emit `/path` (default) and `/{code}/path` (others).
 * - `mode: 'domain'` — replace the host per locale using `locales[code].domains[0]`.
 * - `mode: 'cookie'` — one URL per page, no expansion.
 */
export type I18nConfig = {
	mode?: 'path' | 'cookie' | 'domain';
	defaultLocale?: string;
	locales: Record<string, LocaleDef>;
};

export type SitemapConfig = {
	siteUrl?: string;
	/**
	 * Filename stem for the sitemap, without `.xml`. Default: `'sitemap'`.
	 * Index lives at `/{basename}.xml`; chunks at `/{basename}-N.xml` and
	 * `/{basename}-{group}-N.xml`. Crawlers default to looking at
	 * `/sitemap.xml`, so override only when you have a real conflict.
	 */
	basename?: string;
	/**
	 * Routes to exclude from the sitemap. Each entry is one of:
	 *
	 *   - **Literal path** (no `*` or `?`) — e.g. `'/admin'`. Matches the path
	 *     exactly *and* its descendants (`/admin`, `/admin/users`, `/admin/x/y`).
	 *     Backward-compatible with the original prefix-only semantics.
	 *   - **Glob pattern** (contains `*` or `?`):
	 *     - `*` matches zero or more chars within one path segment (no `/`).
	 *     - `**` matches zero or more chars across segments.
	 *     - `/**\/` between segments collapses to "zero or more segments",
	 *       so `/api/**\/private` matches both `/api/private` and `/api/x/y/private`.
	 *     - `?` matches exactly one non-`/` char.
	 *
	 * `[abc]` and `{a,b}` glob syntax are **not** supported — `[` would collide
	 * with SvelteKit's `[param]` route syntax. Use multiple entries instead.
	 *
	 * Every entry must start with `/`. `/` and `/**` are rejected (would empty
	 * the sitemap).
	 *
	 * @example
	 * exclude: [
	 *   '/admin',           // /admin and all descendants
	 *   '/preview/**',      // strict subtree (does NOT include /preview itself)
	 *   '/blog/draft-*',    // single-segment wildcard
	 *   '/v?/internal',     // single-char wildcard
	 *   '/**\/secret'       // /secret at any depth
	 * ]
	 */
	exclude?: string[];
	/**
	 * Every URL — or pattern — that should appear in the sitemap. The single
	 * source of truth: there's no separate `routes` list.
	 *
	 *   - **Static key** (no `[param]`) — emits one literal URL. Optional
	 *     `{ group?: 'blog' }` to bucket it into a named sub-sitemap.
	 *   - **Dynamic key** (`[id]`, `[...rest]`, `[id=int]`) — needs a resolver
	 *     that returns the IDs to expand. Bare function = default group;
	 *     `{ group: 'blog', resolve: () => [...] }` for a named group.
	 *
	 * To auto-discover SvelteKit routes from `src/routes/`, install the Vite
	 * plugin (`@plcharriere/svelte-sitemap/vite`) and spread its output:
	 *
	 * @example
	 * import { paths as discovered } from 'virtual:sitemap/paths';
	 *
	 * createSitemapHandle({
	 *   paths: {
	 *     ...discovered,                           // every route from src/routes
	 *     '/blog/[id]': () => fetchBlogIds(),     // resolver for the dynamic one
	 *     '/legacy/landing': { group: 'marketing' } // a URL not in src/routes
	 *   }
	 * });
	 *
	 * Without the plugin, just list the URLs you want directly:
	 *
	 * @example
	 * createSitemapHandle({
	 *   paths: { '/': {}, '/about': {}, '/blog/[id]': () => fetchBlogIds() }
	 * });
	 */
	paths?: Record<string, PathConfig>;
	maxEntries?: number;
	defaults?: SitemapEntryMeta;
	cache?: CacheConfig;
	i18n?: I18nConfig;
	/**
	 * Absolute URLs of additional sitemaps to reference from the index — useful
	 * when you have other systems (Shopify, Docusaurus, etc.) emitting their own
	 * `sitemap.xml`. Each URL is appended as a `<sitemap>` entry under our
	 * `<sitemapindex>`. When set, the single-chunk shortcut at `/{basename}.xml`
	 * is skipped so the externals are always reachable.
	 */
	externalSitemaps?: string[];
	/**
	 * Precision of every `<lastmod>` value emitted by the sitemap. Default
	 * `'day'` (YYYY-MM-DD); set `'full'` to emit full ISO timestamps with
	 * millisecond precision and timezone. See `LastmodPrecision` for the
	 * trade-off.
	 */
	lastmodPrecision?: LastmodPrecision;
};
