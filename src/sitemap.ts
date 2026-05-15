import type { SitemapConfig } from '$lib';

const sitemap: SitemapConfig = {
	exclude: ['/admin', '/preview/**'],
	paths: {
		'/my-route': {
			group: 'my-group',
			lastmod: '2026-05-15',
			priority: 0.7
		},
		'/blog/[id]': () => [
			{ params: { id: 'hello-world' }, lastmod: '2026-05-09', priority: 0.7 },
			{ params: { id: 'edge-rendering' }, lastmod: '2026-05-08', priority: 0.7 }
		]
	}
};

export default sitemap;
