import type { ResolvedEntry } from './types.js';

const XML_ESCAPE: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&apos;'
};

function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);
}

// `lastmod` reaches xml.ts already formatted to the configured precision
// (see `formatLastmod` in core.ts). Renderers just emit it verbatim.

function renderEntry(entry: ResolvedEntry): string {
	const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`];
	if (entry.lastmod) parts.push(`    <lastmod>${entry.lastmod}</lastmod>`);
	// Escape defensively — the type union restricts values, but JS callers
	// could bypass and inject XML.
	if (entry.changefreq) parts.push(`    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`);
	if (typeof entry.priority === 'number') {
		parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
	}
	return `  <url>\n${parts.join('\n')}\n  </url>`;
}

export function renderUrlset(entries: ResolvedEntry[]): string {
	const body = entries.map(renderEntry).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

/**
 * One <sitemap> entry in the index. `lastmod` is per-entry so crawlers
 * only re-fetch sub-sitemaps whose group actually rebuilt — and it's already
 * formatted to the configured precision by handle.ts.
 */
export type SitemapIndexEntry = { loc: string; lastmod?: string };

export function renderSitemapIndex(entries: SitemapIndexEntry[]): string {
	const body = entries
		.map((e) => {
			const lines = [`    <loc>${escapeXml(e.loc)}</loc>`];
			if (e.lastmod) lines.push(`    <lastmod>${e.lastmod}</lastmod>`);
			return `  <sitemap>\n${lines.join('\n')}\n  </sitemap>`;
		})
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>
`;
}
