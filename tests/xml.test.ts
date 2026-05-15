import { describe, it, expect } from 'vitest';
import { renderUrlset, renderSitemapIndex, type SitemapIndexEntry } from '../src/lib/xml.js';
import type { ResolvedEntry } from '../src/lib/types.js';

describe('renderUrlset', () => {
	it('emits a valid XML document with the urlset envelope', () => {
		const xml = renderUrlset([{ loc: 'https://example.com/' }]);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
		expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
		expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
	});

	it('renders a single entry with all fields', () => {
		// `lastmod` reaches xml.ts already formatted to the configured precision
		// (formatLastmod runs in core.ts at validation time). xml.ts emits verbatim.
		const xml = renderUrlset([
			{
				loc: 'https://example.com/post/1',
				lastmod: '2024-03-14',
				changefreq: 'weekly',
				priority: 0.8
			}
		]);
		expect(xml).toContain('<loc>https://example.com/post/1</loc>');
		expect(xml).toContain('<lastmod>2024-03-14</lastmod>');
		expect(xml).toContain('<changefreq>weekly</changefreq>');
		expect(xml).toContain('<priority>0.8</priority>');
	});

	it('omits lastmod, changefreq, and priority when absent', () => {
		const xml = renderUrlset([{ loc: 'https://example.com/' }]);
		expect(xml).not.toContain('<lastmod>');
		expect(xml).not.toContain('<changefreq>');
		expect(xml).not.toContain('<priority>');
	});

	it('renders multiple entries', () => {
		const xml = renderUrlset([
			{ loc: 'https://example.com/a' },
			{ loc: 'https://example.com/b' },
			{ loc: 'https://example.com/c' }
		]);
		expect((xml.match(/<url>/g) ?? []).length).toBe(3);
		expect(xml).toContain('https://example.com/a');
		expect(xml).toContain('https://example.com/b');
		expect(xml).toContain('https://example.com/c');
	});

	it('handles an empty entry array', () => {
		const xml = renderUrlset([]);
		expect(xml).toContain('<urlset');
		expect(xml).not.toContain('<url>');
	});

	it('escapes XML metacharacters in loc', () => {
		const xml = renderUrlset([
			{ loc: 'https://example.com/?a=1&b=2&c="x"' }
		]);
		expect(xml).toContain('&amp;');
		expect(xml).toContain('&quot;');
		expect(xml).not.toContain('?a=1&b=2');
	});

	it('escapes <, >, and apostrophes in loc', () => {
		const xml = renderUrlset([{ loc: "https://example.com/<>'" }]);
		expect(xml).toContain('&lt;');
		expect(xml).toContain('&gt;');
		expect(xml).toContain('&apos;');
	});

	it('escapes changefreq defensively (against type-bypass injection)', () => {
		// JS callers could bypass the union type; xml.ts must escape regardless.
		const xml = renderUrlset([
			{ loc: 'https://x', changefreq: '<bad>' as 'always' }
		]);
		expect(xml).toContain('&lt;bad&gt;');
		expect(xml).not.toContain('<bad>');
	});

	it('emits lastmod verbatim — full-precision strings pass through unchanged', () => {
		// Formatting is now the upstream caller's job (core.ts's formatLastmod).
		// xml.ts trusts what it gets and just embeds it.
		const xml = renderUrlset([
			{ loc: 'https://x', lastmod: '2024-12-31T23:59:59.999Z' }
		]);
		expect(xml).toContain('<lastmod>2024-12-31T23:59:59.999Z</lastmod>');
	});

	it('formats priority with exactly one decimal place', () => {
		// We don't assert specific rounding behavior — JS toFixed has float quirks
		// (0.85 → "0.8" because IEEE 754) — only that the format is `0.X`.
		const xml = renderUrlset([{ loc: 'https://x', priority: 0.5 }]);
		expect(xml).toContain('<priority>0.5</priority>');
		const xml2 = renderUrlset([{ loc: 'https://x', priority: 0.7 }]);
		expect(xml2).toContain('<priority>0.7</priority>');
	});

	it('emits priority 0 as "0.0" (not omitted)', () => {
		const xml = renderUrlset([{ loc: 'https://x', priority: 0 }]);
		expect(xml).toContain('<priority>0.0</priority>');
	});

	it('emits priority 1 as "1.0"', () => {
		const xml = renderUrlset([{ loc: 'https://x', priority: 1 }]);
		expect(xml).toContain('<priority>1.0</priority>');
	});

	it('preserves entry ordering', () => {
		const entries: ResolvedEntry[] = [
			{ loc: 'https://x/a' },
			{ loc: 'https://x/b' },
			{ loc: 'https://x/c' }
		];
		const xml = renderUrlset(entries);
		const idxA = xml.indexOf('/a');
		const idxB = xml.indexOf('/b');
		const idxC = xml.indexOf('/c');
		expect(idxA).toBeLessThan(idxB);
		expect(idxB).toBeLessThan(idxC);
	});
});

describe('renderSitemapIndex', () => {
	it('emits a valid sitemapindex envelope', () => {
		const xml = renderSitemapIndex([{ loc: 'https://x/sitemap-1.xml' }]);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
		expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
		expect(xml.trimEnd().endsWith('</sitemapindex>')).toBe(true);
	});

	it('renders entries without lastmod when none provided', () => {
		const xml = renderSitemapIndex([{ loc: 'https://x/sitemap-1.xml' }]);
		expect(xml).toContain('<loc>https://x/sitemap-1.xml</loc>');
		expect(xml).not.toContain('<lastmod>');
	});

	it('renders entries with per-entry lastmod', () => {
		// SitemapIndexEntry.lastmod is now a pre-formatted string — handle.ts
		// runs it through `formatLastmod` before constructing the entries.
		const entries: SitemapIndexEntry[] = [
			{ loc: 'https://x/sitemap-1.xml', lastmod: '2024-01-15' },
			{ loc: 'https://x/sitemap-2.xml', lastmod: '2024-06-30' }
		];
		const xml = renderSitemapIndex(entries);
		expect(xml).toContain('<lastmod>2024-01-15</lastmod>');
		expect(xml).toContain('<lastmod>2024-06-30</lastmod>');
	});

	it('mixes entries with and without lastmod', () => {
		const xml = renderSitemapIndex([
			{ loc: 'https://x/sitemap-1.xml', lastmod: '2024-01-01' },
			{ loc: 'https://shop.x/sitemap.xml' } // external — no lastmod
		]);
		const matches = xml.match(/<lastmod>/g) ?? [];
		expect(matches.length).toBe(1);
	});

	it('escapes loc values', () => {
		const xml = renderSitemapIndex([
			{ loc: 'https://x/path?a=1&b=2' }
		]);
		expect(xml).toContain('&amp;');
	});

	it('handles an empty entries array', () => {
		const xml = renderSitemapIndex([]);
		expect(xml).toContain('<sitemapindex');
		expect(xml).not.toContain('<sitemap>');
	});
});
