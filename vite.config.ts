import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { svelteSitemap } from './src/lib/vite';

export default defineConfig({
	plugins: [svelteSitemap(), sveltekit()]
});
