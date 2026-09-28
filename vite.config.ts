import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectArtifacts, assertProductModules } from './scripts/artifact-policy.mjs';

export default defineConfig(({ command, mode }) => {
  const development = command === 'serve' && mode === 'development';
  const automation = command === 'serve' && mode === 'test';
  const journalId = '\0virtual:development-journal';
  let outputDir = '';
  let projectRoot = '';
  const isolation: Plugin = {
    name: 'product-artifact-isolation',
    enforce: 'post',
    configResolved(config) { outputDir = resolve(config.root, config.build.outDir); projectRoot = config.root; },
    resolveId(id) { if (id === 'virtual:development-journal') return journalId; },
    async load(id) {
      if (id !== journalId) return;
      const contents = development ? await readFile('reports/development/JOURNAL.md', 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) : '';
      return `export default ${JSON.stringify(contents)};`;
    },
    configureServer(server) {
      // Opt-in, local development only. Never copy the private reference into public/.
      server.middlewares.use('/__fixtures__/reference.json', (_req, res) => {
        if (!development || process.env.CLIPBRAID_ENABLE_REFERENCE_FIXTURE !== '1') {
          res.statusCode = 404; res.end('Reference fixture disabled'); return;
        }
        res.setHeader('Content-Type', 'application/json');
        const stream = createReadStream('test-data/reference-project.json');
        stream.on('error', () => { res.statusCode = 404; res.end('Reference fixture missing'); });
        stream.pipe(res);
      });
    },
    async writeBundle(_options, bundle) {
      if (command !== 'build') return;
      assertProductModules(Object.values(bundle).flatMap(item => item.type === 'chunk' ? Object.keys(item.modules) : []), projectRoot);
      const expected = Object.entries(bundle).map(([path, item]) => {
        const bytes = item.type === 'chunk' ? Buffer.from(item.code) : Buffer.from(item.source);
        return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      const files = await inspectArtifacts(outputDir, expected);
      await mkdir('reports', { recursive: true });
      await writeFile('reports/build-artifacts.json', JSON.stringify({ outputDir, files }, null, 2) + '\n');
    },
  };
  return {
    plugins: [react(), tailwindcss(), isolation],
    publicDir: false,
    define: { __DEV_AUTOMATION__: JSON.stringify(automation) },
    server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin' } },
    build: { chunkSizeWarningLimit: 4096, target: 'es2020' },
  };
});
