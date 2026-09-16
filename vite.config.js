import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base works both at site root (Discord Activity iframe, Render)
  // and under the /rrbg/ subpath (GitHub Pages) from a single dist/ build.
  // Server already strips the /rrbg prefix when serving static files.
  base: './',
  plugins: [react()],
  server: { port: 5173 },
});
