import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Optional Vite plugin: scans `src/routes/` and feeds the discovered route
 * patterns to `createSitemapHandle` automatically. With this plugin
 * installed, every `+page` becomes a sitemap entry without you listing it.
 * Skip the plugin and the lib still works — your `paths` config is the
 * only source of URLs.
 *
 *   import { svelteSitemap } from '@plcharriere/svelte-sitemap/vite';
 *   plugins: [svelteSitemap(), sveltekit()]
 *
 * How the magic works: at build/dev time we walk `src/routes/`, then emit
 * a tiny side-effect module that sets `globalThis.__SVELTE_SITEMAP_PATHS__`.
 * Files that import the lib get this module imported at the top via a
 * code transform — so the global is populated before any handle runs.
 */

const VIRTUAL_INIT_ID = 'virtual:sitemap/init';
const RESOLVED_INIT_ID = '\0' + VIRTUAL_INIT_ID;

// Match imports of the lib (npm package or local `$lib` workspace alias).
const LIB_IMPORT_RE =
	/from\s+['"](?:@plcharriere\/svelte-sitemap|\$lib(?:\/[^'"]*)?)['"]/;

const OPTIONAL_PARAM_RE = /\[\[/;

function dirToRoute(rel: string): string {
	const segments = rel.split(path.sep).filter(Boolean);
	const out: string[] = [];
	for (const seg of segments) {
		// Strip layout-group folders like `(marketing)` — they don't appear
		// in the URL path.
		if (seg.startsWith('(') && seg.endsWith(')')) continue;
		out.push(seg);
	}
	return '/' + out.join('/');
}

async function walk(dir: string, base = dir): Promise<string[]> {
	const routes: string[] = [];
	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		// Top-level walk failure usually means a misconfigured routesDir — warn
		// loudly so the user notices instead of getting a silent empty sitemap.
		// Subdirectory failures (permissions, races) silently skip.
		if (dir === base) {
			console.warn(
				`[sitemap] Could not read routesDir "${dir}": ${(err as Error).message}. ` +
					`The sitemap will be empty. Check the routesDir option on svelteSitemap().`
			);
		}
		return routes;
	}

	const hasPage = entries.some((e) => e.isFile() && /^\+page\.(svelte|ts|js)$/.test(e.name));
	if (hasPage) {
		const route = dirToRoute(path.relative(base, dir));
		if (OPTIONAL_PARAM_RE.test(route)) {
			console.warn(
				`[sitemap] Skipping route "${route}": optional params ([[name]]) are not supported. ` +
					`Provide explicit static routes for each variant if you need them indexed.`
			);
		} else {
			routes.push(route);
		}
	}

	// Recurse into subdirectories in parallel — each `readdir` is its own
	// I/O operation, no need to serialize them.
	const childResults = await Promise.all(
		entries.filter((e) => e.isDirectory()).map((e) => walk(path.join(dir, e.name), base))
	);
	for (const child of childResults) routes.push(...child);

	return routes;
}

export type SitemapPluginOptions = {
	routesDir?: string;
};

export function svelteSitemap(options: SitemapPluginOptions = {}): Plugin {
	let routesDir: string;
	let cached: string[] | null = null;

	async function discover(): Promise<string[]> {
		if (cached) return cached;
		const routes = await walk(routesDir);
		routes.sort();
		cached = routes;
		return routes;
	}

	return {
		name: 'svelte-sitemap',
		enforce: 'pre',
		configResolved(config) {
			routesDir = path.resolve(config.root, options.routesDir ?? 'src/routes');
		},
		resolveId(id) {
			if (id === VIRTUAL_INIT_ID) return RESOLVED_INIT_ID;
			return null;
		},
		async load(id) {
			if (id !== RESOLVED_INIT_ID) return null;
			const routes = await discover();
			const paths: Record<string, Record<string, never>> = {};
			for (const r of routes) paths[r] = {};
			// Side-effect: set the slot the lib reads at runtime. JSON.stringify
			// produces valid JS (object literal) for the static map.
			return `globalThis.__SVELTE_SITEMAP_PATHS__ = ${JSON.stringify(paths)};\n`;
		},
		transform(code, id) {
			// Skip the lib's own files (we'd recursively transform ourselves).
			if (id.includes('node_modules') || /\/lib\/(?:index|handle|core|types|vite|xml)\.[jt]s/.test(id)) {
				return null;
			}
			// Only inject into files that actually import the lib.
			if (!LIB_IMPORT_RE.test(code)) return null;
			// Don't double-inject if a previous pass already added it.
			if (code.includes(VIRTUAL_INIT_ID)) return null;
			return {
				code: `import '${VIRTUAL_INIT_ID}';\n${code}`,
				map: null
			};
		},
		configureServer(server) {
			server.watcher.on('add', invalidate);
			server.watcher.on('unlink', invalidate);
			server.watcher.on('addDir', invalidate);
			server.watcher.on('unlinkDir', invalidate);

			function invalidate(file: string) {
				if (!file.startsWith(routesDir)) return;
				cached = null;
				const mod = server.moduleGraph.getModuleById(RESOLVED_INIT_ID);
				if (mod) server.moduleGraph.invalidateModule(mod);
			}
		}
	};
}
