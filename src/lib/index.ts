import {
	createSitemapHandle as createSitemapHandleCore,
	type SitemapHandle
} from './handle.js';
import type { SitemapConfig } from './types.js';

/**
 * Slot the optional Vite plugin fills with auto-discovered paths from
 * `src/routes/`. `undefined` when the plugin isn't installed → no
 * auto-discovery, you list every URL yourself in `paths`.
 */
declare global {
	// eslint-disable-next-line no-var
	var __SVELTE_SITEMAP_PATHS__: Record<string, Record<string, never>> | undefined;
}

export function createSitemapHandle(config: SitemapConfig = {}): SitemapHandle {
	const discovered = globalThis.__SVELTE_SITEMAP_PATHS__ ?? {};
	return createSitemapHandleCore({
		...config,
		paths: { ...discovered, ...(config.paths ?? {}) }
	});
}

export type { SitemapHandle } from './handle.js';
export type {
	CacheAdapter,
	CacheConfig,
	CachedChunk,
	CachedGroupMeta,
	ChangeFreq,
	GroupedResolver,
	I18nConfig,
	LastmodPrecision,
	LocaleDef,
	MaybePromise,
	PathConfig,
	ResolvedEntry,
	Resolver,
	ResolverEntry,
	SitemapConfig,
	SitemapEntryMeta
} from './types.js';
