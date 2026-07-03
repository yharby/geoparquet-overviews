import { defineConfig } from 'vite';

// Relative base so the built viewer works on any static host, including a
// GitHub Pages project subpath like /geoparquet-overviews/.
export default defineConfig({
  base: './',
});
