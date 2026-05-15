import {
	DEFAULT_GROUP,
	type CacheAdapter,
	type CachedChunk,
	type CachedGroupMeta,
	type GroupedResolver,
	type I18nConfig,
	type LastmodPrecision,
	type Resolver,
	type ResolvedEntry,
	type ResolverEntry,
	type SitemapConfig,
	type SitemapEntryMeta
} from './types.js';

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_BASENAME = 'sitemap';
const GROUP_RE = /^[a-z][\w-]*$/;
// Same shape as group names — validated charset means no regex escaping needed downstream.
const BASENAME_RE = /^[a-z][\w-]*$/;

// Captures: 1=rest marker (`...` or undefined), 2=param name.
// `[^\[\]=]` excludes `[` so `[[id]]` cannot match `[id` as a name.
const PARAM_RE = /\[(\.\.\.)?([^\[\]=]+?)(?:=[^\]]+)?\]/g;

/**
 * One compiled exclude rule. Created once at startup by `resolveExclude` so
 * neither validation nor regex compilation runs on the hot path.
 */
export type ExcludeMatcher = (pathname: string) => boolean;

// A rule is a glob iff it contains `*` or `?`. We deliberately don't treat
// `[`/`{` as glob signals — they collide with SvelteKit's `[param]` /
// `[[opt]]` route syntax, which appears verbatim in `routes` (the values
// `isExcluded` is matched against).
const GLOB_DETECT_RE = /[*?]/;
// Regex meta-characters we have to escape when emitting literal text.
// Includes `[` and `]` so SvelteKit's `[param]` survives glob compilation.
const REGEX_META_RE = /[.+^$()|\\\[\]{}]/g;

function escRegex(s: string): string {
	return s.replace(REGEX_META_RE, '\\$&');
}

/**
 * Compile a glob pattern to an anchored RegExp. Supports:
 *   `*`   — zero or more chars within a single path segment (no `/`)
 *   `**`  — zero or more chars across path segments
 *   `/**\/` — collapses to "zero or more path segments" (so `/a/**\/b`
 *           matches both `/a/b` and `/a/x/b`)
 *   `?`   — exactly one non-`/` char
 * Everything else is matched literally.
 */
function globToRegExp(pattern: string): RegExp {
	let re = '';
	const n = pattern.length;
	let i = 0;
	while (i < n) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				// `/**/` collapses across path separators: turn the already-emitted
				// trailing `/` plus the next `/` into an optional `/segments/`.
				if (pattern[i - 1] === '/' && pattern[i + 2] === '/' && re.endsWith('/')) {
					re = re.slice(0, -1) + '(?:/.*)?/';
					i += 3;
					continue;
				}
				re += '.*';
				i += 2;
				continue;
			}
			re += '[^/]*';
			i++;
			continue;
		}
		if (c === '?') {
			re += '[^/]';
			i++;
			continue;
		}
		re += escRegex(c);
		i++;
	}
	return new RegExp('^' + re + '$');
}

/**
 * Validate and compile every `config.exclude` rule once at startup.
 * Throws on malformed or dangerously broad rules; returns matchers ready
 * for hot-path use.
 */
export function resolveExclude(config: SitemapConfig): ExcludeMatcher[] {
	const rules = config.exclude ?? [];
	return rules.map((rule, idx) => compileExcludeRule(rule, idx));
}

function compileExcludeRule(rule: unknown, idx: number): ExcludeMatcher {
	if (typeof rule !== 'string' || rule.length === 0 || !rule.startsWith('/')) {
		throw new Error(
			`[sitemap] exclude[${idx}] ${JSON.stringify(rule)} must be a non-empty string starting with "/".`
		);
	}
	if (rule === '/' || rule === '/**') {
		throw new Error(
			`[sitemap] exclude[${idx}] "${rule}" would match every route. Use a more specific pattern.`
		);
	}
	if (GLOB_DETECT_RE.test(rule)) {
		const re = globToRegExp(rule);
		return (p) => re.test(p);
	}
	// Literal: matches the exact path AND its descendants. Backward-compatible
	// shorthand — `/admin` excludes `/admin`, `/admin/users`, etc., without
	// the user having to write `/admin{,/**}`.
	const literal = rule;
	const prefix = literal.endsWith('/') ? literal : literal + '/';
	return (p) => p === literal || p.startsWith(prefix);
}

function isExcluded(pathname: string, matchers: ExcludeMatcher[]): boolean {
	for (const m of matchers) if (m(pathname)) return true;
	return false;
}

function fillParams(pattern: string, params: Record<string, string>): string {
	return pattern.replace(PARAM_RE, (_, isRest: string | undefined, name: string) => {
		const value = params[name];
		if (value === undefined || value === null) {
			throw new Error(
				`[sitemap] Resolver for "${pattern}" returned an entry missing param "${name}".`
			);
		}
		const str = String(value);
		// Rest params hold a multi-segment path; encode each segment but keep the slashes.
		if (isRest) {
			return str.split('/').filter(Boolean).map(encodeURIComponent).join('/');
		}
		return encodeURIComponent(str);
	});
}

function extractParamNames(pattern: string): string[] {
	const names: string[] = [];
	for (const m of pattern.matchAll(PARAM_RE)) names.push(m[2]);
	return names;
}

/**
 * Format a Date as the configured precision: `'day'` slices to YYYY-MM-DD,
 * `'full'` keeps the full ISO timestamp. Both are valid sitemap lastmod values
 * per the W3C Datetime spec the sitemap protocol references.
 */
export function formatLastmod(d: Date, precision: LastmodPrecision): string {
	const iso = d.toISOString();
	return precision === 'day' ? iso.slice(0, 10) : iso;
}

function validateLastmod(
	value: Date | string | undefined,
	loc: string,
	precision: LastmodPrecision
): string | undefined {
	if (value === undefined) return undefined;
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) {
		throw new Error(`[sitemap] Invalid lastmod for "${loc}": ${JSON.stringify(value)}`);
	}
	// Normalize to a string at the configured precision once, so renderers can
	// emit `entry.lastmod` verbatim — no reparse, no reformat per render.
	return formatLastmod(d, precision);
}

function validatePriority(value: number | undefined, loc: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(
			`[sitemap] Invalid priority for "${loc}": ${value}. Must be a finite number between 0 and 1.`
		);
	}
	return value;
}

function applyMeta(
	loc: string,
	meta: SitemapEntryMeta | undefined,
	defaults: SitemapEntryMeta | undefined,
	precision: LastmodPrecision
): ResolvedEntry {
	const lastmod = validateLastmod(meta?.lastmod ?? defaults?.lastmod, loc, precision);
	const priority = validatePriority(meta?.priority ?? defaults?.priority, loc);
	return {
		loc,
		lastmod,
		changefreq: meta?.changefreq ?? defaults?.changefreq,
		priority
	};
}

/**
 * Unpack the object form of a `paths` value. The function form is handled
 * directly by callers (it's a bare resolver in the default group), so this
 * helper only ever sees `GroupedResolver`.
 */
function unpackPathConfig(value: GroupedResolver): {
	group: string;
	resolve: Resolver | undefined;
	meta: SitemapEntryMeta;
} {
	// Only include defined meta fields — spreading `{ priority: undefined }`
	// would clobber a defined value from `config.defaults`.
	const meta: SitemapEntryMeta = {};
	if (value.lastmod !== undefined) meta.lastmod = value.lastmod;
	if (value.changefreq !== undefined) meta.changefreq = value.changefreq;
	if (value.priority !== undefined) meta.priority = value.priority;
	return {
		group: value.group ?? DEFAULT_GROUP,
		resolve: value.resolve,
		meta
	};
}

function validateI18n(i18n: I18nConfig | undefined): void {
	if (!i18n) return;
	if (i18n.defaultLocale && !(i18n.defaultLocale in i18n.locales)) {
		throw new Error(
			`[sitemap] i18n.defaultLocale "${i18n.defaultLocale}" is not in i18n.locales — its URLs would be missing from the sitemap.`
		);
	}
	// Domain mode without any configured domains silently produces nothing for
	// non-default locales. Warn once at startup so it doesn't masquerade as a
	// "the library doesn't expand my locales" bug.
	if (i18n.mode === 'domain') {
		const codes = Object.keys(i18n.locales);
		const hasAnyDomain = codes.some((c) => i18n.locales[c]?.domains?.[0]);
		if (!hasAnyDomain) {
			console.warn(
				`[sitemap] i18n.mode === 'domain' but no locale has a domain configured. ` +
					`Non-default locale URLs will be missing from the sitemap.`
			);
		}
		// Fail fast on a malformed domain — `withLocaleDomain` parses these per entry
		// and would otherwise blow up on the first request instead of at boot.
		for (const code of codes) {
			const domain = i18n.locales[code]?.domains?.[0];
			if (!domain) continue;
			try {
				new URL(domain.includes('://') ? domain : `https://${domain}`);
			} catch {
				throw new Error(
					`[sitemap] i18n.locales["${code}"].domains[0] is not a parseable URL or hostname: "${domain}".`
				);
			}
		}
	}
}

function validateGroupName(group: string): void {
	if (group !== DEFAULT_GROUP && !GROUP_RE.test(group)) {
		throw new Error(
			`[sitemap] invalid group name "${group}". Group names must start with a lowercase letter and contain only letters, digits, hyphens, or underscores.`
		);
	}
}

/** A route is dynamic if it contains any `[param]` segment. */
function isDynamic(route: string): boolean {
	return route.includes('[');
}

/**
 * Run every startup-time validation in one pass. Called from `createSitemapHandle`
 * so misconfiguration fails (or at minimum warns) at boot instead of on the
 * first request — and warnings fire exactly once per process.
 *
 * `excludeMatchers` is supplied by `resolveExclude`, which validated the raw
 * `config.exclude` strings before this function ran.
 */
export function validateConfig(
	config: SitemapConfig,
	excludeMatchers: ExcludeMatcher[]
): void {
	validateI18n(config.i18n);

	const paths = config.paths ?? {};

	for (const [key, value] of Object.entries(paths)) {
		// Function-as-pathConfig is a resolver — only meaningful for dynamic
		// keys. Caught here at startup instead of throwing per request.
		if (typeof value === 'function') {
			if (!isDynamic(key)) {
				throw new Error(
					`[sitemap] paths["${key}"] is a static path — use { group: '...' } instead of a resolver function.`
				);
			}
			continue;
		}
		// Guard against bypass-the-types misconfig. Without this, an opaque
		// "Cannot read properties of null/undefined" surfaces from `value.group`.
		if (value === null || typeof value !== 'object') {
			throw new Error(
				`[sitemap] paths["${key}"] must be a function or { group?, resolve? }, got ${value === null ? 'null' : typeof value}.`
			);
		}
		const group = value.group ?? DEFAULT_GROUP;
		validateGroupName(group);
	}

	// Warn for paths keys excluded by config.exclude — they're configured but
	// won't contribute any URLs at request time.
	for (const key of Object.keys(paths)) {
		if (isExcluded(key, excludeMatchers)) {
			console.warn(
				`[sitemap] paths["${key}"] is configured but excluded by config.exclude — its entries won't appear in the sitemap.`
			);
		}
	}

	// Warn for dynamic patterns that have no resolver — they contribute zero
	// URLs at request time. Excluded keys are skipped (resolver irrelevant).
	for (const [key, pathConfig] of Object.entries(paths)) {
		if (!isDynamic(key)) continue;
		if (isExcluded(key, excludeMatchers)) continue;
		if (typeof pathConfig === 'function') continue; // resolver present
		if (!pathConfig.resolve) {
			console.warn(
				`[sitemap] paths["${key}"] is a dynamic pattern with no resolver. ` +
					`Its URLs will be missing from the sitemap — add a 'resolve' function.`
			);
		}
	}
}

type BuildContext = {
	siteUrl: string;
	config: SitemapConfig;
	excludeMatchers: ExcludeMatcher[];
	/**
	 * SvelteKit's `paths.base` (already folded into `siteUrl` upstream). Surfaced
	 * separately because path-mode i18n needs to insert `/code` *after* the base
	 * prefix, not before it — `https://example.com/myapp/fr/about`, not
	 * `https://example.com/fr/myapp/about`.
	 */
	base?: string;
	/**
	 * Lastmod output precision. Tests can omit (defaults to `'day'`); handle.ts
	 * passes the resolved value at request time.
	 */
	lastmodPrecision?: LastmodPrecision;
};

export type GroupedEntries = Map<string, ResolvedEntry[]>;

function pushEntry(map: GroupedEntries, group: string, entry: ResolvedEntry): void {
	let bucket = map.get(group);
	if (!bucket) {
		bucket = [];
		map.set(group, bucket);
	}
	bucket.push(entry);
}

function withLocalePrefix(loc: string, code: string, base: string): string {
	const url = new URL(loc);
	// Strip base before inserting the locale code, then put base back. This keeps
	// the locale prefix *inside* the deployment subpath, which is what SvelteKit
	// path-mode i18n expects: `/myapp/fr/about`, not `/fr/myapp/about`.
	let rest = url.pathname;
	if (base && rest.startsWith(base)) rest = rest.slice(base.length);
	const prefixed = rest === '' || rest === '/' ? `/${code}` : `/${code}${rest}`;
	url.pathname = base + prefixed;
	return url.toString();
}

function withLocaleDomain(loc: string, domain: string): string {
	const url = new URL(loc);
	// Accept bare hostname (`fr.example.com`) or full URL (`https://fr.example.com:8080`).
	// Throws on a malformed domain — that's intentional. A silently-broken host
	// produces a URL that looks plausible but isn't, and you'd only catch it at
	// crawl time. Better to fail loudly at startup with the bad input visible.
	const target = new URL(domain.includes('://') ? domain : `https://${domain}`);
	url.hostname = target.hostname;
	url.protocol = target.protocol;
	// Adopt the target's port — if the domain string didn't specify one, target.port
	// is `''`, which clears any port inherited from `loc`.
	url.port = target.port;
	return url.toString();
}

function expandLocales(
	entry: ResolvedEntry,
	i18n: I18nConfig | undefined,
	base: string
): ResolvedEntry[] {
	if (!i18n || !i18n.mode || i18n.mode === 'cookie') return [entry];
	const codes = Object.keys(i18n.locales);
	if (codes.length === 0) return [entry];

	const out: ResolvedEntry[] = [];
	if (i18n.mode === 'domain') {
		for (const code of codes) {
			const domain = i18n.locales[code]?.domains?.[0];
			if (!domain) {
				if (code === i18n.defaultLocale) out.push(entry);
				continue;
			}
			out.push({ ...entry, loc: withLocaleDomain(entry.loc, domain) });
		}
		return out;
	}

	// mode === 'path'
	for (const code of codes) {
		if (code === i18n.defaultLocale) {
			out.push(entry);
		} else {
			out.push({ ...entry, loc: withLocalePrefix(entry.loc, code, base) });
		}
	}
	return out;
}

export async function buildEntries(
	ctx: BuildContext,
	groupsFilter?: Set<string>
): Promise<GroupedEntries> {
	const { siteUrl, config, excludeMatchers } = ctx;
	const base = ctx.base ?? '';
	const precision: LastmodPrecision = ctx.lastmodPrecision ?? 'day';
	const defaults = config.defaults;
	const paths = config.paths ?? {};
	const grouped: GroupedEntries = new Map();

	// Single iteration over every paths entry. Static (no `[`) processes
	// synchronously — emit one entry, no params. Dynamic queues an async
	// resolver task that runs in parallel with the others.
	const dynamicTasks: Array<Promise<{ group: string; entries: ResolvedEntry[] }>> = [];

	for (const [route, pathConfig] of Object.entries(paths)) {
		if (isExcluded(route, excludeMatchers)) continue;
		const dynamic = isDynamic(route);

		// Resolve group + (optionally) the resolver function + per-path meta.
		// validateConfig has already rejected the function-on-static-path case
		// at startup, so we don't re-check it here.
		let group = DEFAULT_GROUP;
		let resolve: Resolver | undefined;
		let pathMeta: SitemapEntryMeta = {};
		if (typeof pathConfig === 'function') {
			resolve = pathConfig;
		} else {
			const unpacked = unpackPathConfig(pathConfig);
			group = unpacked.group;
			resolve = unpacked.resolve;
			pathMeta = unpacked.meta;
		}

		if (groupsFilter && !groupsFilter.has(group)) continue;

		// Static path: emit one entry. Per-path meta wins over global defaults.
		if (!dynamic) {
			const entry = applyMeta(absolute(siteUrl, route), pathMeta, defaults, precision);
			for (const expanded of expandLocales(entry, config.i18n, base)) {
				pushEntry(grouped, group, expanded);
			}
			continue;
		}

		// Dynamic path: needs a resolver. Missing-resolver warning is emitted
		// once at startup by validateConfig; here we just skip silently.
		if (!resolve) continue;

		// Per-path meta acts as a per-path default for resolver entries —
		// overrides config.defaults, gets overridden by each entry's own meta.
		const mergedDefaults: SitemapEntryMeta = { ...defaults, ...pathMeta };
		dynamicTasks.push(
			resolveDynamic(route, group, resolve, siteUrl, mergedDefaults, config.i18n, base, precision)
		);
	}

	// Wait for all resolver-driven groups to finish, then merge.
	for (const result of await Promise.all(dynamicTasks)) {
		for (const entry of result.entries) {
			pushEntry(grouped, result.group, entry);
		}
	}

	return grouped;
}

/**
 * Run one dynamic route's resolver and produce its entries. Extracted so
 * `buildEntries` doesn't need an inline `async (route) =>` inside its loop.
 */
async function resolveDynamic(
	route: string,
	group: string,
	resolve: Resolver,
	siteUrl: string,
	defaults: SitemapEntryMeta | undefined,
	i18n: I18nConfig | undefined,
	base: string,
	precision: LastmodPrecision
): Promise<{ group: string; entries: ResolvedEntry[] }> {
	const expectedParams = extractParamNames(route);
	const items = await resolve();
	if (!Array.isArray(items)) {
		throw new Error(
			`[sitemap] Resolver for "${route}" must return an array of entries, got ${typeof items}.`
		);
	}

	const entries: ResolvedEntry[] = [];
	for (const item of items as ResolverEntry[]) {
		if (!item || typeof item !== 'object' || !item.params) {
			throw new Error(
				`[sitemap] Resolver for "${route}" returned an invalid entry (expected { params, ... }).`
			);
		}
		for (const name of expectedParams) {
			if (!(name in item.params)) {
				throw new Error(
					`[sitemap] Resolver for "${route}" returned entry missing param "${name}".`
				);
			}
		}
		const filled = fillParams(route, item.params);
		const entry = applyMeta(absolute(siteUrl, filled), item, defaults, precision);
		for (const expanded of expandLocales(entry, i18n, base)) {
			entries.push(expanded);
		}
	}
	return { group, entries };
}

/**
 * The set of groups configured. Computed once at startup. Index serving and
 * full-invalidate need to know what to enumerate; we never want to discover
 * groups by reading the cache.
 */
export function enumerateGroups(config: SitemapConfig): Set<string> {
	const groups = new Set<string>([DEFAULT_GROUP]);
	for (const value of Object.values(config.paths ?? {})) {
		if (typeof value === 'function') continue;
		const group = value.group ?? DEFAULT_GROUP;
		groups.add(group);
	}
	return groups;
}

function absolute(siteUrl: string, pathname: string): string {
	const base = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
	const path = pathname.startsWith('/') ? pathname : '/' + pathname;
	return base + path;
}

function chunkEntries(entries: ResolvedEntry[], maxEntries: number): ResolvedEntry[][] {
	// `maxEntries` is already validated and clamped by `resolveMaxEntries`
	// at startup — guaranteed to be in [1, DEFAULT_MAX_ENTRIES].
	const chunks: ResolvedEntry[][] = [];
	for (let i = 0; i < entries.length; i += maxEntries) {
		chunks.push(entries.slice(i, i + maxEntries));
	}
	return chunks;
}

/**
 * Newest `entry.lastmod` (ms since epoch) across a slice. `lastmod` was already
 * normalized to an ISO string at validation time, so `Date.parse` is safe.
 * Returns `0` when no entry has a lastmod — caller falls back to build time.
 */
function newestLastmodMs(entries: ResolvedEntry[]): number {
	let newest = 0;
	for (const e of entries) {
		if (!e.lastmod) continue;
		const t = Date.parse(e.lastmod);
		if (Number.isFinite(t) && t > newest) newest = t;
	}
	return newest;
}

const META_MEMO_MS = 5_000;

/** `meta` for the default group, `meta:{group}` for named groups. */
function metaKey(group: string): string {
	return group === DEFAULT_GROUP ? 'meta' : `meta:${group}`;
}

/**
 * Chunks live under their group's `version`, so a failed mid-rebuild can't
 * overwrite chunks the current group meta points at. Old versions linger
 * in storage until the adapter's TTL evicts them.
 */
function chunkKey(version: string, group: string, index: number): string {
	const tail = group === DEFAULT_GROUP ? `${index}` : `${group}:${index}`;
	return `chunk:${version}:${tail}`;
}

function newVersion(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const TOMBSTONE_GROUP_META: CachedGroupMeta = {
	siteUrl: '',
	expiresAt: 0,
	lastBuilt: 0,
	version: '',
	count: 0
};

/** Arguments to per-group rebuilds. */
type GroupBuild = (groups: Set<string>) => Promise<GroupedEntries>;

export class SitemapStore {
	private memory = new Map<string, unknown>();
	/** Short-lived in-process cache of each group's meta — one entry per group. */
	private metaMemo = new Map<string, { meta: CachedGroupMeta; readAt: number }>();
	/** Per-group rebuild dedup: concurrent requests for the same group share one rebuild. */
	private rebuildInflight = new Map<string, Promise<CachedGroupMeta>>();
	private adapter: CacheAdapter | null;
	private ttlSeconds: number;

	constructor(options: { ttl?: number; adapter?: CacheAdapter | null } = {}) {
		this.ttlSeconds = options.ttl ?? DEFAULT_TTL_SECONDS;
		this.adapter = options.adapter ?? null;
	}

	get ttl(): number {
		return this.ttlSeconds;
	}

	private async read<T>(key: string): Promise<T | null> {
		const value = this.adapter ? await this.adapter.get(key) : this.memory.get(key);
		return (value as T | undefined) ?? null;
	}

	private async write(key: string, value: unknown): Promise<void> {
		if (this.adapter) await this.adapter.set(key, value, this.ttlSeconds);
		else this.memory.set(key, value);
	}

	/**
	 * In-memory adapter only: delete chunk keys for the given group that don't
	 * match the current version. External adapters rely on their own TTL to
	 * evict orphan chunks; the in-memory Map never expires anything, so each
	 * rebuild would otherwise leak its predecessor's chunks indefinitely.
	 */
	private gcInMemoryOrphans(group: string, currentVersion: string): void {
		if (this.adapter) return;
		// chunk:version:index            → 3 parts, default group
		// chunk:version:group:index      → 4 parts, named group
		const expectedLen = group === DEFAULT_GROUP ? 3 : 4;
		for (const key of this.memory.keys()) {
			if (!key.startsWith('chunk:')) continue;
			const parts = key.split(':');
			if (parts.length !== expectedLen) continue;
			if (parts[1] === currentVersion) continue;
			if (group !== DEFAULT_GROUP && parts[2] !== group) continue;
			this.memory.delete(key);
		}
	}

	async getMeta(
		group: string,
		siteUrl: string,
		build: GroupBuild,
		maxEntries: number
	): Promise<CachedGroupMeta> {
		const now = Date.now();

		// Hot path: served from process memory if read recently and still fresh.
		const memo = this.metaMemo.get(group);
		if (
			memo &&
			now - memo.readAt < META_MEMO_MS &&
			memo.meta.siteUrl === siteUrl &&
			memo.meta.expiresAt > now
		) {
			return memo.meta;
		}

		// Cold path: round-trip to storage.
		const cached = await this.read<CachedGroupMeta>(metaKey(group));
		if (
			cached &&
			cached.version &&
			typeof cached.count === 'number' &&
			cached.siteUrl === siteUrl &&
			cached.expiresAt > now
		) {
			this.metaMemo.set(group, { meta: cached, readAt: now });
			return cached;
		}
		return this.rebuildGroup(group, siteUrl, build, maxEntries);
	}

	async loadChunk(
		meta: CachedGroupMeta,
		group: string,
		index: number
	): Promise<CachedChunk | null> {
		if (index < 1 || index > meta.count) return null;
		const chunk = await this.read<CachedChunk>(chunkKey(meta.version, group, index));
		if (chunk && chunk.siteUrl === meta.siteUrl && chunk.version === meta.version) {
			return chunk;
		}
		return null;
	}

	async getChunk(
		siteUrl: string,
		group: string,
		index: number,
		build: GroupBuild,
		maxEntries: number
	): Promise<{ meta: CachedGroupMeta; chunk: CachedChunk | null }> {
		const meta = await this.getMeta(group, siteUrl, build, maxEntries);
		if (index < 1 || index > meta.count) {
			return { meta, chunk: null };
		}
		const chunk = await this.loadChunk(meta, group, index);
		if (chunk) return { meta, chunk };
		// Chunk missing or stale — rebuild only this group, then re-read.
		const refreshed = await this.rebuildGroup(group, siteUrl, build, maxEntries);
		const after = await this.loadChunk(refreshed, group, index);
		return { meta: refreshed, chunk: after };
	}

	async invalidate(groups: Iterable<string>): Promise<void> {
		const list = [...groups];
		// Step 1: make the *storage* layer reflect invalidation. For external
		// adapters we tombstone (so multi-replica stores can't serve the stale
		// value). For the in-memory adapter we just delete.
		if (this.adapter) {
			await Promise.all(
				list.map((group) =>
					this.adapter!.set(metaKey(group), TOMBSTONE_GROUP_META, this.ttlSeconds)
				)
			);
		} else {
			for (const group of list) this.memory.delete(metaKey(group));
		}
		// Step 2: clear the memo. Order matters — if we cleared the memo first,
		// a concurrent reader could miss the memo, hit the adapter before the
		// tombstone landed, get the stale meta back, and repopulate the memo
		// with it (re-extending staleness by a memo TTL).
		for (const group of list) this.metaMemo.delete(group);
	}

	/**
	 * Rebuild a single group: run only that group's resolvers, write its chunks,
	 * commit its meta. Other groups' caches are completely untouched.
	 */
	private rebuildGroup(
		group: string,
		siteUrl: string,
		build: GroupBuild,
		maxEntries: number
	): Promise<CachedGroupMeta> {
		const existing = this.rebuildInflight.get(group);
		if (existing) return existing;

		const promise = (async () => {
			try {
				const grouped = await build(new Set([group]));
				const entries = grouped.get(group) ?? [];
				const version = newVersion();
				const expiresAt = Date.now() + this.ttlSeconds * 1000;
				const chunks = chunkEntries(entries, maxEntries);
				const count = chunks.length;
				const chunkLastmods = chunks.map(newestLastmodMs);

				// Write all chunks for this group in parallel.
				const writes = chunks.map((slice, i) => {
					const value: CachedChunk = {
						siteUrl,
						group,
						index: i + 1,
						version,
						entries: slice
					};
					return this.write(chunkKey(version, group, i + 1), value);
				});
				await Promise.all(writes);

				// In-memory adapter doesn't honor TTL — drop the previous version's
				// chunks for this group so memory stays bounded across rebuilds.
				this.gcInMemoryOrphans(group, version);

				// Group meta written last — commit signal for this group.
				const meta: CachedGroupMeta = {
					siteUrl,
					expiresAt,
					lastBuilt: Date.now(),
					version,
					count,
					chunkLastmods
				};
				await this.write(metaKey(group), meta);
				this.metaMemo.set(group, { meta, readAt: Date.now() });
				return meta;
			} finally {
				this.rebuildInflight.delete(group);
			}
		})();

		this.rebuildInflight.set(group, promise);
		return promise;
	}
}

export function resolveCache(config: SitemapConfig): {
	ttl: number;
	adapter: CacheAdapter | null;
} {
	const cache = config.cache;
	const ttl = cache?.ttl ?? DEFAULT_TTL_SECONDS;
	if (!Number.isFinite(ttl) || ttl < 1) {
		throw new Error(`[sitemap] cache.ttl must be a positive number of seconds, got ${ttl}.`);
	}
	if (!cache) return { ttl, adapter: null };

	// Destructure-then-narrow so TS knows `get`/`set` are functions inside
	// the both-present branch — no `!` assertions needed.
	const { get, set } = cache;
	if (typeof get === 'function' && typeof set === 'function') {
		return { ttl, adapter: { get, set } };
	}
	if (typeof get === 'function' || typeof set === 'function') {
		throw new Error('[sitemap] cache adapter requires both `get` and `set` to be provided.');
	}
	return { ttl, adapter: null };
}

export function resolveMaxEntries(config: SitemapConfig): number {
	const value = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(
			`[sitemap] maxEntries must be a positive integer, got ${value}.`
		);
	}
	if (value > DEFAULT_MAX_ENTRIES) {
		console.warn(
			`[sitemap] maxEntries (${value}) exceeds the sitemap protocol limit (${DEFAULT_MAX_ENTRIES}); clamping.`
		);
	}
	return Math.min(value, DEFAULT_MAX_ENTRIES);
}

export function resolveLastmodPrecision(config: SitemapConfig): LastmodPrecision {
	const value = config.lastmodPrecision ?? 'day';
	if (value !== 'day' && value !== 'full') {
		throw new Error(
			`[sitemap] lastmodPrecision must be 'day' or 'full', got ${JSON.stringify(value)}.`
		);
	}
	return value;
}

export function resolveBasename(config: SitemapConfig): string {
	const value = config.basename ?? DEFAULT_BASENAME;
	if (!BASENAME_RE.test(value)) {
		throw new Error(
			`[sitemap] basename "${value}" is invalid. Must start with a lowercase letter and contain only letters, digits, hyphens, or underscores.`
		);
	}
	return value;
}

export function resolveExternalSitemaps(config: SitemapConfig): string[] {
	const externals = config.externalSitemaps ?? [];
	for (const url of externals) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(
				`[sitemap] externalSitemaps entry "${url}" is not a valid absolute http(s) URL.`
			);
		}
		// Exact match — `startsWith('http')` would let through `httpx://`, etc.
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(
				`[sitemap] externalSitemaps entry "${url}" must use http: or https: (got ${parsed.protocol}).`
			);
		}
	}
	return externals;
}

/**
 * Validate `config.siteUrl` once at startup (or return null when relying on
 * the request origin). Per-request resolution then becomes a single nullish
 * coalesce — no URL re-parse on the hot path.
 */
export function resolveStaticSiteUrl(config: SitemapConfig): string | null {
	const candidate = config.siteUrl;
	if (candidate === undefined) return null;
	try {
		new URL(candidate);
	} catch {
		throw new Error(
			`[sitemap] siteUrl "${candidate}" is not a valid URL. Configure config.siteUrl explicitly.`
		);
	}
	return candidate.replace(/\/$/, '');
}
