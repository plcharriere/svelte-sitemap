import { createSitemapHandle } from '$lib';
import sitemap from './sitemap';

// Auto-discovery happens inside `createSitemapHandle` (the main entry imports
// the Vite plugin's virtual module and merges its paths under yours). To use
// the lib WITHOUT the plugin, swap to `@plcharriere/svelte-sitemap/manual`
// and list every URL in `sitemap.paths` yourself.
export const handle = createSitemapHandle(sitemap);
