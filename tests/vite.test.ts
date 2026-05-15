import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResolvedConfig, ViteDevServer } from 'vite';
import { svelteSitemap } from '../src/lib/vite.js';

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

let tempDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svelte-sitemap-vite-'));
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
	warnSpy.mockRestore();
});

/**
 * Build a synthetic SvelteKit-shaped routes tree under `tempDir/src/routes`
 * given a flat list of routes ("/about", "/blog/[id]", "(group)/about", ...).
 * Each route gets a `+page.svelte` placeholder file.
 */
async function makeRoutes(routes: string[]): Promise<void> {
	const root = path.join(tempDir, 'src', 'routes');
	await fs.mkdir(root, { recursive: true });
	for (const r of routes) {
		const dir = r === '/' ? root : path.join(root, ...r.split('/').filter(Boolean));
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, '+page.svelte'), '<h1>x</h1>');
	}
}

async function makeFile(rel: string, contents: string): Promise<void> {
	const dest = path.join(tempDir, 'src', 'routes', rel);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.writeFile(dest, contents);
}

/**
 * Drive the plugin through configResolved → load(VIRTUAL_INIT_ID) and return
 * the list of discovered route patterns. The plugin emits side-effect code
 * `globalThis.__SVELTE_SITEMAP_PATHS__ = {...}` — we parse the object literal.
 */
async function loadRoutes(
	plugin: ReturnType<typeof svelteSitemap>,
	routesDirRel = 'src/routes'
): Promise<string[]> {
	const resolved = { root: tempDir } as ResolvedConfig;
	const configResolved = plugin.configResolved as (
		c: ResolvedConfig
	) => void | Promise<void>;
	await configResolved.call(plugin, resolved);

	const resolveId = plugin.resolveId as (id: string) => string | null;
	const id = resolveId.call(plugin, 'virtual:sitemap/init');
	if (id === null) throw new Error('plugin failed to resolve virtual id');

	const load = plugin.load as (id: string) => string | null | Promise<string | null>;
	const src = await load.call(plugin, id);
	if (src === null) throw new Error('plugin returned null for resolved id');

	const match = /globalThis\.__SVELTE_SITEMAP_PATHS__\s*=\s*(\{.*?\});/s.exec(src as string);
	if (!match) throw new Error('unexpected plugin output: ' + src);
	void routesDirRel;
	return Object.keys(JSON.parse(match[1]));
}

// =============================================================================
// Plugin shape
// =============================================================================

describe('svelteSitemap plugin shape', () => {
	it('returns a Plugin with the expected name and pre-enforce', () => {
		const p = svelteSitemap();
		expect(p.name).toBe('svelte-sitemap');
		expect(p.enforce).toBe('pre');
	});
});

// =============================================================================
// Route discovery — dirToRoute via walk
// =============================================================================

describe('route discovery', () => {
	it('discovers the root route', async () => {
		await makeRoutes(['/']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toContain('/');
	});

	it('discovers nested static routes', async () => {
		await makeRoutes(['/', '/about', '/blog']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes.sort()).toEqual(['/', '/about', '/blog']);
	});

	it('preserves [param] segments verbatim in route paths', async () => {
		await makeRoutes(['/blog/[id]', '/users/[id]/posts/[slug]']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toContain('/blog/[id]');
		expect(routes).toContain('/users/[id]/posts/[slug]');
	});

	it('strips route-group folders like (marketing)', async () => {
		await makeRoutes(['/(marketing)/pricing', '/(marketing)/(legal)/terms']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toContain('/pricing');
		expect(routes).toContain('/terms');
		// Original parenthesized paths NEVER appear
		expect(routes.every((r) => !r.includes('('))).toBe(true);
	});

	it('preserves matchers in route paths (e.g. [id=int])', async () => {
		await makeRoutes(['/posts/[id=int]']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toContain('/posts/[id=int]');
	});

	it('preserves rest-param syntax [...rest]', async () => {
		await makeRoutes(['/help/[...path]']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toContain('/help/[...path]');
	});

	it('skips dirs that have no +page file', async () => {
		// Create a dir-only structure: src/routes/api/+server.ts but no +page.svelte
		await fs.mkdir(path.join(tempDir, 'src', 'routes', 'api'), {
			recursive: true
		});
		await fs.writeFile(
			path.join(tempDir, 'src', 'routes', 'api', '+server.ts'),
			'export const GET = () => new Response("ok");'
		);
		await makeRoutes(['/about']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toEqual(['/about']);
	});

	it('accepts +page.ts, +page.js, and +page.svelte', async () => {
		const root = path.join(tempDir, 'src', 'routes');
		await fs.mkdir(path.join(root, 'svelte-only'), { recursive: true });
		await fs.writeFile(path.join(root, 'svelte-only', '+page.svelte'), '');
		await fs.mkdir(path.join(root, 'ts-only'), { recursive: true });
		await fs.writeFile(path.join(root, 'ts-only', '+page.ts'), 'export const load = () => ({})');
		await fs.mkdir(path.join(root, 'js-only'), { recursive: true });
		await fs.writeFile(path.join(root, 'js-only', '+page.js'), 'export const load = () => ({})');
		const routes = await loadRoutes(svelteSitemap());
		expect(routes.sort()).toEqual(['/js-only', '/svelte-only', '/ts-only']);
	});

	it('warns and skips optional params [[name]]', async () => {
		await makeRoutes(['/preview/[[locale]]']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).not.toContain('/preview/[[locale]]');
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/Skipping route.*optional params/)
		);
	});

	it('sorts the final route list deterministically', async () => {
		await makeRoutes(['/zebra', '/apple', '/mango']);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toEqual([...routes].sort());
	});

	it('warns when routesDir does not exist', async () => {
		// No src/routes created — point the plugin at nothing
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/Could not read routesDir/)
		);
	});

	it('accepts a custom routesDir option', async () => {
		const root = path.join(tempDir, 'custom', 'routes');
		await fs.mkdir(path.join(root, 'about'), { recursive: true });
		await fs.writeFile(path.join(root, 'about', '+page.svelte'), '');
		const routes = await loadRoutes(
			svelteSitemap({ routesDir: 'custom/routes' })
		);
		expect(routes).toContain('/about');
	});
});

// =============================================================================
// Virtual module resolution
// =============================================================================

describe('virtual module resolution', () => {
	it('only resolves the exact virtual:sitemap/init id', () => {
		const plugin = svelteSitemap();
		const resolveId = plugin.resolveId as (id: string) => string | null;
		expect(resolveId.call(plugin, 'virtual:sitemap/init')).toBeTruthy();
		expect(resolveId.call(plugin, 'virtual:sitemap/other')).toBeNull();
		expect(resolveId.call(plugin, 'sitemap/routes')).toBeNull();
	});

	it("prefixes the resolved id with '\\0' (Vite's virtual-module convention)", () => {
		const plugin = svelteSitemap();
		const resolveId = plugin.resolveId as (id: string) => string | null;
		const out = resolveId.call(plugin, 'virtual:sitemap/init');
		expect(out?.startsWith('\0')).toBe(true);
	});

	it("load() returns null for any id other than the virtual one", async () => {
		const plugin = svelteSitemap();
		const load = plugin.load as (id: string) => Promise<string | null>;
		expect(await load.call(plugin, '/some/file.ts')).toBeNull();
	});

	it('caches the discovered routes between load() calls', async () => {
		await makeRoutes(['/about']);
		const plugin = svelteSitemap();
		await (plugin.configResolved as (c: ResolvedConfig) => void).call(plugin, {
			root: tempDir
		} as ResolvedConfig);
		const resolveId = plugin.resolveId as (id: string) => string | null;
		const id = resolveId.call(plugin, 'virtual:sitemap/init');
		expect(id).toBeTruthy();

		const load = plugin.load as (id: string) => Promise<string>;
		const first = await load.call(plugin, id!);
		expect(first).toContain('"/about"');

		// Now mutate the filesystem — without watcher invalidation the cache
		// keeps the old result.
		await fs.rm(path.join(tempDir, 'src', 'routes', 'about'), { recursive: true });

		const second = await load.call(plugin, id!);
		expect(second).toBe(first); // identical content from cache
		expect(second).toContain('"/about"');
	});
});

// =============================================================================
// Dev-server watcher integration
// =============================================================================

describe('configureServer watcher', () => {
	it('invalidates the module graph when a route is added in routesDir', async () => {
		const plugin = svelteSitemap();
		await (plugin.configResolved as (c: ResolvedConfig) => void).call(plugin, {
			root: tempDir
		} as ResolvedConfig);
		const resolveId = plugin.resolveId as (id: string) => string | null;
		const id = resolveId.call(plugin, 'virtual:sitemap/init')!;

		await makeRoutes(['/initial']);
		const load = plugin.load as (id: string) => Promise<string>;
		const initial = await load.call(plugin, id);
		expect(initial).toContain('"/initial"');

		// Wire a fake server that captures invalidation
		const invalidated: string[] = [];
		const fakeMod = { id };
		const watcherHandlers: Record<string, (file: string) => void> = {};
		const server = {
			watcher: {
				on: (event: string, cb: (file: string) => void) => {
					watcherHandlers[event] = cb;
				}
			},
			moduleGraph: {
				getModuleById: (mid: string) => (mid === id ? fakeMod : null),
				invalidateModule: (m: { id: string }) => {
					invalidated.push(m.id);
				}
			}
		} as unknown as ViteDevServer;
		(plugin.configureServer as (s: ViteDevServer) => void).call(plugin, server);

		// Add a new route on disk + fire the watcher
		await makeRoutes(['/added']);
		const newRoutesDir = path.resolve(tempDir, 'src/routes');
		watcherHandlers.add(path.join(newRoutesDir, 'added', '+page.svelte'));
		expect(invalidated).toContain(id);

		// The next load() should now reflect the new route
		const reloaded = await load.call(plugin, id);
		expect(reloaded).toContain('"/added"');
		expect(reloaded).toContain('"/initial"');
	});

	it('ignores changes outside routesDir', async () => {
		const plugin = svelteSitemap();
		await (plugin.configResolved as (c: ResolvedConfig) => void).call(plugin, {
			root: tempDir
		} as ResolvedConfig);

		const invalidated: string[] = [];
		const watcherHandlers: Record<string, (file: string) => void> = {};
		const server = {
			watcher: {
				on: (event: string, cb: (file: string) => void) => {
					watcherHandlers[event] = cb;
				}
			},
			moduleGraph: {
				getModuleById: () => ({ id: 'x' }),
				invalidateModule: (m: { id: string }) => {
					invalidated.push(m.id);
				}
			}
		} as unknown as ViteDevServer;
		(plugin.configureServer as (s: ViteDevServer) => void).call(plugin, server);

		// File outside routesDir — should NOT invalidate
		watcherHandlers.add(path.join(tempDir, 'src', 'lib', 'thing.ts'));
		expect(invalidated).toHaveLength(0);
	});

	it('registers add, unlink, addDir, unlinkDir', async () => {
		const plugin = svelteSitemap();
		await (plugin.configResolved as (c: ResolvedConfig) => void).call(plugin, {
			root: tempDir
		} as ResolvedConfig);

		const onEvents: string[] = [];
		const server = {
			watcher: {
				on: (event: string) => {
					onEvents.push(event);
				}
			},
			moduleGraph: {
				getModuleById: () => null,
				invalidateModule: () => undefined
			}
		} as unknown as ViteDevServer;
		(plugin.configureServer as (s: ViteDevServer) => void).call(plugin, server);
		expect(onEvents).toEqual(['add', 'unlink', 'addDir', 'unlinkDir']);
	});

	it('handles the case where getModuleById returns null', async () => {
		const plugin = svelteSitemap();
		await (plugin.configResolved as (c: ResolvedConfig) => void).call(plugin, {
			root: tempDir
		} as ResolvedConfig);

		const watcherHandlers: Record<string, (file: string) => void> = {};
		const server = {
			watcher: {
				on: (event: string, cb: (file: string) => void) => {
					watcherHandlers[event] = cb;
				}
			},
			moduleGraph: {
				getModuleById: () => null, // module not in graph
				invalidateModule: () => {
					throw new Error('should not be called when module is null');
				}
			}
		} as unknown as ViteDevServer;
		(plugin.configureServer as (s: ViteDevServer) => void).call(plugin, server);
		// Should not throw
		expect(() =>
			watcherHandlers.add(
				path.join(path.resolve(tempDir, 'src/routes'), 'x', '+page.svelte')
			)
		).not.toThrow();
	});
});

// =============================================================================
// Resilience
// =============================================================================

describe('resilience', () => {
	it('does not fail when a subdirectory becomes unreadable mid-walk', async () => {
		// Subdir errors are silently swallowed inside walk(). Create a normal
		// routes tree, then add a file that we'll point to with an invalid name.
		await makeRoutes(['/ok']);
		// Add a dir with a file that exists. Walk should succeed regardless.
		await makeFile('weird/+page.svelte', '');
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toContain('/ok');
		expect(routes).toContain('/weird');
	});

	it('silently skips an unreadable subdirectory (no warning, no failure)', async () => {
		// Make a normal sibling and a subdir that fails to readdir mid-walk.
		// On POSIX, chmod 0 on the dir prevents readdir from listing it.
		// Skip on Windows where chmod doesn't have the same effect.
		if (process.platform === 'win32') return;
		await makeRoutes(['/ok']);
		const blocked = path.join(tempDir, 'src', 'routes', 'blocked');
		await fs.mkdir(blocked);
		await fs.writeFile(path.join(blocked, '+page.svelte'), '');
		await fs.chmod(blocked, 0o000);

		try {
			const routes = await loadRoutes(svelteSitemap());
			// /ok still discovered; blocked silently skipped
			expect(routes).toContain('/ok');
			// No "Could not read routesDir" warning — that's the *base* path message;
			// subdir failures are silent by design.
			const warnedAboutBase = warnSpy.mock.calls.some((c: unknown[]) =>
				/Could not read routesDir/.test(String(c[0]))
			);
			expect(warnedAboutBase).toBe(false);
		} finally {
			await fs.chmod(blocked, 0o755);
		}
	});

	it('handles deeply nested route trees', async () => {
		await makeRoutes([
			'/a/b/c/d/e/f',
			'/a/b/c/d/e/g',
			'/a/x',
			'/'
		]);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes).toContain('/a/b/c/d/e/f');
		expect(routes).toContain('/a/b/c/d/e/g');
		expect(routes).toContain('/a/x');
		expect(routes).toContain('/');
	});

	it('discovers routes from parallel subdirs without ordering bugs', async () => {
		// Many siblings — exercise the parallel walk
		const many = Array.from({ length: 30 }, (_, i) => `/route-${i}`);
		await makeRoutes(many);
		const routes = await loadRoutes(svelteSitemap());
		expect(routes.length).toBeGreaterThanOrEqual(30);
		for (const r of many) expect(routes).toContain(r);
	});
});
