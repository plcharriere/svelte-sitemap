# svelte-sitemap

`sitemap.xml` for **SvelteKit 2 + Svelte 5**. A `handle` hook serves the XML; an optional Vite plugin discovers your routes. Static routes appear automatically, dynamic routes (`/blog/[id]`) take a resolver for their IDs, and past `maxEntries` URLs (default 50K, the protocol max) `/sitemap.xml` becomes a `<sitemapindex>` pointing at chunked sub-sitemaps.

```ts
// src/hooks.server.ts
import { createSitemapHandle } from '@plcharriere/svelte-sitemap';

export const handle = createSitemapHandle({
  paths: {
    '/blog/[id]': () =>
      db.posts.map((p) => ({ params: { id: p.slug }, lastmod: p.updatedAt }))
  }
});
```

`/sitemap.xml` is now served — static routes and blog posts included, cached. At 1M URLs the output splits across 21 chunks served as `/sitemap-1.xml` … `/sitemap-21.xml` behind a `<sitemapindex>`.

The main entry point merges routes auto-discovered from `src/routes/` (via the Vite plugin) with your `paths` config — you only list the entries that need resolvers, groups, or custom URLs.

Don't want the plugin? Don't add it. The lib still works — just supply every URL via `paths` yourself.

## Install

```sh
npm install @plcharriere/svelte-sitemap
```

```sh
pnpm add @plcharriere/svelte-sitemap
```

```sh
yarn add @plcharriere/svelte-sitemap
```

```sh
bun add @plcharriere/svelte-sitemap
```

## Usage

### 1. Add the Vite plugin

The plugin scans `src/routes/` at build/dev time and feeds the discovered routes into the handle automatically — no wiring on your side.

```ts
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteSitemap } from '@plcharriere/svelte-sitemap/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelteSitemap(), sveltekit()]
});
```

It applies SvelteKit's filesystem conventions: route groups `(group)/about` collapse to `/about`, dynamic segments `[id]`, `[...rest]` and matchers `[id=int]` are preserved verbatim. Optional params `[[id]]` are skipped with a warning — they don't have a single canonical URL. Anything you want kept out of the sitemap should go in `exclude`.

If you don't want auto-discovery (e.g. all your URLs come from a database, not `src/routes/`), skip this step. The hook still works — your `paths` config is the only source of URLs.

### 2. Wire the handle hook

```ts
// src/hooks.server.ts
import { createSitemapHandle } from '@plcharriere/svelte-sitemap';

export const handle = createSitemapHandle({
  paths: {
    '/blog/[id]': () =>
      db.posts.map((p) => ({
        params: { id: p.slug },
        lastmod: p.updatedAt,
        changefreq: 'weekly',
        priority: 0.7
      })),

    // Optional: a URL not in src/routes — added on top of auto-discovery
    '/legacy/landing': { group: 'marketing' }
  }
});
```

When the plugin is installed it injects discovered routes via a global slot the lib reads at runtime — your `paths` config is merged on top. So you only declare resolvers/groups/custom URLs.

**Without the plugin:** the same import works, the slot is just empty. List every path yourself:

```ts
import { createSitemapHandle } from '@plcharriere/svelte-sitemap';

export const handle = createSitemapHandle({
  paths: {
    '/': {},
    '/about': {},
    '/blog/[id]': () => db.posts.map((p) => ({ params: { id: p.slug } }))
  }
});
```

The hook intercepts `/sitemap.xml` and `/sitemap-N.xml` before SvelteKit routes them — no `+server.ts` files to write. Every other URL falls through to your app untouched.

`siteUrl` defaults to `event.url.origin` so absolute URLs in the XML always match the deployed domain. Set it explicitly when behind a CDN/proxy that rewrites the origin.

### 3. Tell crawlers about it

Add one line to your `robots.txt` so crawlers find the sitemap:

```
# static/robots.txt
Sitemap: https://example.com/sitemap.xml
```

Just the index — crawlers follow `<sitemap>` references inside the index automatically, so you never list individual chunks (`/sitemap-1.xml`, `/sitemap-blog-1.xml`, etc.) in `robots.txt`. SvelteKit serves `static/robots.txt` directly; if you generate it dynamically via `+server.ts`, write that one line into your output the same way.

The library deliberately does **not** auto-manage `robots.txt` — your file controls all crawler behavior (User-agent, Disallow, Crawl-delay, etc.) and we don't want to silently merge with or overwrite your rules.

**Custom basename.** If you can't use `/sitemap.xml` (e.g., the URL is already taken by a static file you can't move), pass `basename: 'urls'` and the library serves at `/urls.xml` with chunks at `/urls-1.xml`, `/urls-blog-1.xml`, etc. Update your `robots.txt` to point at the new path — crawlers don't auto-probe alternative names.

```ts
createSitemapHandle({ basename: 'urls', ... })
// → /urls.xml, /urls-1.xml, /urls-blog-1.xml
```

Basename must match `/^[a-z][\w-]*$/` (start with a lowercase letter, then letters/digits/hyphens/underscores).

### 4. Resolvers

A resolver returns an array of entries. Each entry has the params SvelteKit's filesystem expects, plus optional sitemap metadata.

```ts
{
  '/blog/[id]': () => [
    { params: { id: 'first-post' }, lastmod: '2026-01-15', priority: 0.8 },
    { params: { id: 'second-post' }, lastmod: '2026-02-03' }
  ]
}
```

Param names are validated against the route pattern at build time — if `/users/[userId]/posts/[postId]`'s resolver returns `params: { userId: '1' }` (missing `postId`), you get a clear error instead of a silently broken URL.

Three equivalent shapes for the default group:

```ts
'/blog/[id]': () => entries,                            // bare function
'/blog/[id]': { resolve: () => entries },               // object, no group
'/blog/[id]': { group: 'blog', resolve: () => entries } // object with group
```

The bare function form is the shortest and recommended unless you want grouping (next section).

### 5. Groups

By default all entries share one chunk-numbering sequence: `/sitemap-1.xml`, `/sitemap-2.xml`, ... When you want a section's chunks named explicitly — for SEO reporting, ops clarity, or a future per-group invalidation API — set `group`:

```ts
paths: {
  '/blog/[id]': { group: 'blog', resolve: () => fetchBlogIds() },
  '/forum/[topic]/[post]': { group: 'forum', resolve: () => fetchForumIds() }
}
```

Now your index looks like:

```
/sitemap.xml                    ← <sitemapindex>
  /sitemap-1.xml                ← static routes (default group)
  /sitemap-blog-1.xml           ← blog group, chunk 1
  /sitemap-blog-2.xml           ← blog group, chunk 2
  /sitemap-forum-1.xml          ← forum group, chunk 1
```

Group names must match `/^[a-z][\w-]*$/` so they can never collide with the numeric chunk indices.

**Static routes can be grouped too.** A static page like `/blog` (the listing) and its dynamic children `/blog/[id]` belong together logically; pass an entry without `resolve` to put a static route in a custom group:

```ts
paths: {
  '/blog': { group: 'blog' },                                     // static listing
  '/blog/[id]': { group: 'blog', resolve: () => fetchBlogIds() }  // dynamic posts
}
```

Now both `/blog` and the post URLs end up in `/sitemap-blog-1.xml`, with `/`, `/about`, etc. staying in the default group's `/sitemap-1.xml`.

Validation: passing a function for a static path (`'/blog': () => [...]`) throws at startup — static paths don't take resolvers. Passing an entry without `resolve` for a dynamic pattern (`'/blog/[id]': { group: 'blog' }`) warns at startup — without a resolver we don't know which IDs to expand, so the route contributes nothing.

### 6. Cache (KV adapter)

The full entry list is cached in chunks of `maxEntries` (default 50K). By default the cache is in-process (a single `Map`), which is fine for a single server but cold on every restart. Plug in any external store via `get`/`set`:

```ts
import { kv } from '$lib/server/kv';

createSitemapHandle({
  paths: { ... },
  cache: {
    ttl: 3600, // 1 hour, in seconds
    get: (key) => kv.get(`sitemap:${key}`, 'json'),
    set: (key, value, ttl) =>
      kv.put(`sitemap:${key}`, JSON.stringify(value), { expirationTtl: ttl })
  }
});
```

The library passes opaque keys (`meta`, `meta:blog`, `chunk:<version>:1`, `chunk:<version>:blog:1`, …) and serializable JSON values. Each group has its own meta key and its own version, so per-group invalidation only touches that group. Namespace however you like in your adapter. Both `get` and `set` are required together; supplying only one is a TypeScript error and a runtime error.

**TTL and freshness.** `ttl` is in **seconds** to match HTTP `Cache-Control: max-age`, Redis `EX`, Cloudflare KV `expirationTtl`, etc. — values pass straight through to your storage's native expiration. The library bakes an absolute `expiresAt` into the cached value at write time, so freshness is enforced regardless of whether your storage honors the TTL. Default: `3600` (1 hour). The HTTP `Cache-Control: max-age` header is set from the same value (clamped at a 60s minimum).

**Invalidation.** Call `handle.invalidate()` from a CMS webhook, post-deploy hook, or admin endpoint. Pass a group name to invalidate just that group; omit to wipe everything.

```ts
// src/routes/admin/republish/+server.ts
import { handle } from '../../../hooks.server';

export async function POST({ url }) {
  // ?group=blog → only blog rebuilds, other groups stay warm
  // (no query)  → every group invalidated
  const group = url.searchParams.get('group') ?? undefined;
  await handle.invalidate(group);
  return new Response(null, { status: 204 });
}
```

Per-group invalidation is the right call for content systems where one section changes often (blog) and others rarely (docs, customers). Only the dirty group's resolvers re-run and only its chunks get rewritten — the other groups serve from cache. Unknown group names throw at the call site so typos surface immediately.

**Scheduled rebuilds.** `invalidate()` only *marks* the cache stale — the next request pays the rebuild cost. When resolvers are slow (a paginated external API like Shopify), that penalty lands on a crawler. `handle.rebuild()` instead does the work itself, so requests afterwards hit an already-warm cache. Drive it from a cron job hitting a protected endpoint:

```ts
// src/routes/api/rebuild-sitemap/+server.ts
import { handle } from '../../../hooks.server';
import { CRON_SECRET } from '$env/static/private';

export async function POST({ request }) {
  if (request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  await handle.rebuild();           // throws → 500 → your cron monitor alerts
  return new Response(null, { status: 204 });
}
```

`rebuild()` runs without a request, so it can't infer the origin — set `config.siteUrl`, or pass `{ siteUrl }`. Pass `{ group }` to rebuild a single group; omit it to rebuild all. It rejects with an `AggregateError` if any group's resolvers throw, but groups that succeeded are still committed — a failed rebuild never corrupts or empties the cache.

`rebuild()` is only useful with an **external cache adapter**: the in-process cache isn't shared across serverless instances, so a cron-warmed in-memory cache wouldn't reach the instances serving requests.

### 7. i18n

Pass an i18n config (the same shape as [`@plcharriere/svelte-i18n`](https://github.com/plcharriere/svelte-i18n)) and every URL gets expanded across your locales.

```ts
createSitemapHandle({
  paths: { ... },
  i18n: {
    mode: 'path',
    defaultLocale: 'en',
    locales: {
      en: {},
      fr: {},
      de: {}
    }
  }
});
```

If you already use `@plcharriere/svelte-i18n`, pass the same config object — the sitemap library reads only `mode`, `defaultLocale`, and `locales[code].domains`, ignoring everything else.

**`mode: 'path'`** — emit one entry per locale, prefix-mapped:

```
/about           ← default locale (en), unprefixed
/fr/about        ← fr
/de/about        ← de
```

**`mode: 'domain'`** — replace the host per locale using `locales[code].domains[0]`:

```
https://example.com/about       ← default locale (en), uses request origin
https://fr.example.com/about    ← fr
https://de.example.com/about    ← de
```

Provide bare hostnames (`'fr.example.com'`) or full URLs (`'https://fr.example.com:8080'`). The default locale uses the request origin unless it has its own `domains` entry. A domain string that can't be parsed as a hostname or URL fails fast at startup — a silently-broken host produces URLs you'd only catch at crawl time.

**`mode: 'cookie'`** — no expansion. One URL per page; the cookie-driven runtime handles per-user locale resolution. Crawlers see the default.

**Don't add hreflang in the sitemap.** Google says the HTML `<link rel="alternate" hreflang="...">` in your `<head>` is equivalent to sitemap-level `<xhtml:link>` annotations — declaring in both is just noise. The sitemap's job is making every URL discoverable; head tags do the alternate-grouping.

**Localized slugs (`/fr/contact` vs `/fr/nous-contacter`).** Pure prefix mapping assumes identical slugs across locales. If your slugs differ per locale, expand them yourself in your resolver and skip the `i18n` config:

```ts
'/blog/[id]': () => [
  { params: { id: 'about-us' } },
  { params: { id: 'a-propos' } },  // pre-mapped per locale
  ...
]
```

### 8. External sitemaps

If you have other systems emitting their own sitemaps (Shopify subdomain, Docusaurus docs, etc.) and want crawlers to discover everything from one canonical entry point, list them via `externalSitemaps`:

```ts
createSitemapHandle({
  paths: { ... },
  externalSitemaps: [
    'https://shop.example.com/sitemap.xml',
    'https://docs.example.com/sitemap.xml'
  ]
});
```

They appear as `<sitemap>` entries in our `<sitemapindex>` alongside the chunks we generate. The library doesn't fetch them — they're just references for crawlers to follow.

URLs must be absolute http(s) (validated at startup). Setting `externalSitemaps` also disables the single-chunk-default shortcut at `/{basename}.xml`, since a `<urlset>` cannot reference other sitemaps — the index form is the only way to surface externals.

### 9. Excluding routes

`exclude` accepts both literal paths and glob patterns. Detection is automatic — a rule is a glob iff it contains `*` or `?`.

```ts
createSitemapHandle({
  exclude: [
    '/admin',          // literal: /admin AND every descendant (/admin/users, …)
    '/preview/**',     // glob: subtree only — does NOT include /preview itself
    '/blog/draft-*',   // single-segment wildcard
    '/v?/internal',    // single-char wildcard
    '/**/secret'       // /secret at any depth (/secret, /a/b/secret, …)
  ]
});
```

| Token | Meaning |
|---|---|
| `*` | zero or more chars within one path segment (no `/`) |
| `**` | zero or more chars across segments |
| `/**/` | between segments, collapses to "zero or more segments" — `/api/**/private` matches both `/api/private` and `/api/x/y/private` |
| `?` | exactly one non-`/` char |

**No `[abc]` or `{a,b}` syntax** — `[` would collide with SvelteKit's `[param]` route syntax (which appears verbatim in route paths). For alternation, use multiple entries.

**Literal vs glob semantics**: `/admin` (literal) matches `/admin` and its descendants — backward-compatible shorthand. `/admin/**` (strict glob) matches the descendants only. Pick whichever reads better; they're not interchangeable.

Patterns are validated and compiled once at startup. `/` and `/**` are rejected (would empty the sitemap). A `paths[key]` whose key is excluded triggers a startup warning so you don't silently configure dead routes.

### 10. Subpath deployments

If your app is deployed under a path prefix — SvelteKit's `kit.paths.base`, e.g. hosted at `example.com/myapp` — the library picks it up automatically. No config needed: it reads `base` from `$app/paths` and

- serves the sitemap at `/myapp/sitemap.xml` (chunks at `/myapp/sitemap-N.xml`, `/myapp/sitemap-blog-1.xml`, …),
- prefixes every `<loc>` with the base (`https://example.com/myapp/about`),
- lets requests outside the base prefix fall through untouched — including ones that merely share a prefix, like `/myapp-other/page`.

Path-mode i18n composes correctly: the locale code goes *inside* the base prefix — `https://example.com/myapp/fr/about`, not `https://example.com/fr/myapp/about`. Domain-mode i18n keeps the base in the path on each locale's host.

### 11. lastmod precision

Every `<lastmod>` is emitted at day precision (`YYYY-MM-DD`) by default. Set `lastmodPrecision: 'full'` for full ISO timestamps:

```ts
createSitemapHandle({ paths: { ... }, lastmodPrecision: 'full' });
```

| Value | Output | Trade-off |
|---|---|---|
| `'day'` (default) | `2026-03-10` | Smaller payload, matches what most static-site generators emit. Two updates the same day produce the same value. |
| `'full'` | `2026-03-10T14:32:17.500Z` | Every modification advances the value — useful when crawlers refetch frequently and you want sub-day resolution. |

It applies uniformly to per-entry `<lastmod>` and to the `<sitemap>` entries in the index.

**Index `<lastmod>` reflects content, not build time.** Each `<sitemap>` entry in the index carries the *newest* `lastmod` among the entries in that chunk. So a chunk's `<lastmod>` only moves forward when its content actually changes — crawlers can skip refetching sub-sitemaps that haven't changed, instead of re-pulling them on every cache rebuild. When no entry in a chunk has a `lastmod`, it falls back to the build time.

## How requests are served

| URL | KV reads | Notes |
|---|---|---|
| `/sitemap.xml` (single chunk) | meta + chunk:1 | renders `<urlset>` directly |
| `/sitemap.xml` (multi chunk) | **just meta** | renders `<sitemapindex>` |
| `/sitemap-N.xml` | meta + chunk:N | only the requested chunk |
| `/sitemap-blog-N.xml` | meta + chunk:blog:N | only the requested chunk |

The index serve is **O(1)** in entry count — at 1M URLs / 21 chunks, it's still one KV read.

## Features

- **Auto-discovery** — static routes are picked up from `src/routes/` automatically. Dynamic routes ask for resolvers; missing resolvers are warned, not silently dropped.
- **Chunked output** — anything past `maxEntries` URLs (default 50K) paginates into `/sitemap-N.xml` files behind a `<sitemapindex>`. Each full-size chunk fits comfortably under Cloudflare KV's 25 MB value cap (~10 MB at the default).
- **Pluggable cache** — works with any KV that has `get`/`set`. Library handles freshness via embedded `expiresAt`. Inflight dedup ensures concurrent cache misses only trigger one rebuild.
- **Groups** — name the chunks per route family for clarity (`/sitemap-blog-1.xml`) without giving up auto-packing inside each group.
- **Origin-aware** — `siteUrl` defaults to the request origin, so preview deploys never serve cached prod URLs.
- **Subpath-aware** — deployed under a `kit.paths.base` prefix? Routing, `<loc>` URLs, and path-mode i18n all compose with the base automatically, no config.
- **Crawl-efficient index** — each `<sitemap>` in the index carries its chunk's newest entry `lastmod`, so crawlers skip refetching sub-sitemaps that haven't changed.
- **Type-safe** — every public option is typed; resolver params are validated against the route pattern at runtime.
- **Validation** — `priority` is range-checked (0–1), `lastmod` is parsed at build time, `maxEntries` is clamped to the protocol limit. Bad input fails fast with a useful message.
- **Zero per-route boilerplate** — install plugin, add hook, optionally write resolvers. No `+server.ts` files, no manual chunk lists.

## Configuration

```ts
type SitemapConfig = {
  siteUrl?: string;             // default: event.url.origin
  basename?: string;            // default 'sitemap'; serves at /{basename}.xml
  exclude?: string[];           // literal prefix or glob (`*`, `**`, `?`) — see § Excluding routes
  paths?: Record<string, PathConfig>;
  maxEntries?: number;          // default 50000 (protocol max)
  defaults?: SitemapEntryMeta;  // applied to every entry that doesn't override
  cache?: CacheConfig;
  i18n?: I18nConfig;
  externalSitemaps?: string[];  // absolute http(s) URLs to merge into the index
  lastmodPrecision?: 'day' | 'full';  // <lastmod> format — default 'day' (YYYY-MM-DD)
};

type I18nConfig = {
  mode?: 'path' | 'cookie' | 'domain';
  defaultLocale?: string;
  locales: Record<string, { domains?: string[] }>;
};

type PathConfig =
  | (() => MaybePromise<ResolverEntry[]>)        // bare resolver, default group
  | { group?: string; resolve: () => MaybePromise<ResolverEntry[]> };

type ResolverEntry = {
  params: Record<string, string>;
  lastmod?: Date | string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;            // 0.0 – 1.0
};

type CacheConfig = {
  ttl?: number;                 // seconds, default 3600 (1h)
  get?: (key: string) => MaybePromise<unknown>;
  set?: (key: string, value: unknown, ttl: number) => MaybePromise<void>;
};
```

## API

### Setup

| Export | Purpose |
| --- | --- |
| `createSitemapHandle(config)` | Returns a SvelteKit `Handle` with an extra `.invalidate()` method. |
| `svelteSitemap(options?)` | Vite plugin (`@plcharriere/svelte-sitemap/vite`). Auto-discovers routes. |

### Methods on the returned handle

| Member | Purpose |
| --- | --- |
| `handle` | The `Handle` itself — drop into `hooks.server.ts`. |
| `handle.invalidate(group?)` | Clear the cache. Pass a group to invalidate just that group; omit to wipe everything. Async. |
| `handle.rebuild(options?)` | Proactively rebuild the cache off the request path (for a cron job). Needs an explicit `siteUrl` (config or `options.siteUrl`). Pass `options.group` to rebuild one group. Async. |

### Plugin options

| Option | Default | Purpose |
| --- | --- | --- |
| `routesDir` | `'src/routes'` | Override if your routes live elsewhere. |

## Limits and tradeoffs

- **In-memory build** — the resolver returns a single array. At 1M+ entries the array uses ~150 MB during rebuild. Async-generator resolvers are on the roadmap; for now, paginate inside your resolver if you need to.
- **Cross-instance race** — two server instances rebuilding simultaneously can produce inconsistent reads on the chunk-vs-meta boundary. The library detects and rebuilds rather than serving mixed data, but distributed locks aren't part of the design.
- **Optional params (`[[id]]`)** — skipped with a warning. The library doesn't pick a canonical URL for you.
- **No prerender helper** — the design is runtime-first. If you fully prerender the site, add `/sitemap.xml` and your chunk URLs to `kit.prerender.entries` manually.
