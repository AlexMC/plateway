import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The build's id for error reports (src/net/telemetry.ts): the git commit, or the build time where there is no .git
 * (the Docker build). */
function buildId(): string {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return new Date().toISOString().slice(0, 16).replace(/[-:]/g, ''); }
}

export default defineConfig({
  // The app lives at `/app/` beside the landing site at `/` (cad/service/app.py); the API stays at `/api/`.
  base: '/app/',
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  // Train models (glTF binaries) are assets; the app loads them from public/trains, tests import fixtures inline.
  assetsInclude: ['**/*.glb'],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true } }
  }
});
