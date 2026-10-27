import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectArtifacts, assertProductModules, assertSafeOutputDirectory, assertProductArtifact } from './scripts/artifact-policy.mjs';
import { sourceIdentity, repositoryState } from './scripts/source-identity.mjs';
import brandIdentity from './brand.json';
import packageMetadata from './package.json';

export default defineConfig(({ command, mode }) => {
  const identity = sourceIdentity();
  const buildId = `${identity.sha256}:${command === 'build' ? 'production' : mode}`;
  const development = command === 'serve' && mode === 'development';
  const automation = command === 'serve' && mode === 'test';
  let outputDir = '';
  let projectRoot = '';
  let buildConfiguration: Record<string, unknown> = {};
  const isolation: Plugin = {
    name: 'product-artifact-isolation',
    enforce: 'post',
    configResolved(config) {
      outputDir = resolve(config.root, config.build.outDir); projectRoot = config.root;
      if(command === 'build')assertSafeOutputDirectory(outputDir);
      buildConfiguration={command,mode,base:config.base,target:config.build.target,sourcemap:config.build.sourcemap,
        nodeEnv:process.env.NODE_ENV ?? null,automation,publicDir:false};
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const values: Record<string, string> = { PRODUCT_TITLE: `${brandIdentity.name} — ${brandIdentity.tagline}`, PRODUCT_DESCRIPTION: `${brandIdentity.name} — ${brandIdentity.description}`,
          PRODUCT_THEME: brandIdentity.themeColor, PRODUCT_FAVICON: brandIdentity.favicon };
        return html.replace(/%PRODUCT_(TITLE|DESCRIPTION|THEME|FAVICON)%/g, (_match, key: string) => values[`PRODUCT_${key}`].replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
      },
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
    generateBundle(_options,bundle) {
      if(command!=='build')return;
      assertProductModules(Object.values(bundle).flatMap(item=>item.type==='chunk'?Object.keys(item.modules):[]),projectRoot);
      for(const [name,item] of Object.entries(bundle))assertProductArtifact(name,item.type==='chunk'?item.code:item.source);
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
      await writeFile('reports/build-artifacts.json', JSON.stringify({ schemaVersion: 1, buildId,
        source: { ...repositoryState(), inputsSha256: identity.sha256 }, configuration:buildConfiguration,
        toolchain:{node:process.version,vite:packageMetadata.devDependencies.vite},outputDir, files }, null, 2) + '\n');
    },
  };
  return {
    plugins: [react(), tailwindcss(), isolation],
    worker: {
      format: "es",
      rollupOptions: {
        output: { entryFileNames: chunk => `assets/${chunk.name.replaceAll(".", "-")}-[hash].js` },
      },
      plugins: () => [{
        name: "worker-module-isolation",
        generateBundle(_options, bundle) {
          assertProductModules(Object.values(bundle).flatMap(item => item.type === "chunk" ? Object.keys(item.modules) : []), projectRoot);
        },
      }],
    },
    publicDir: false,
    define: { __DEV_AUTOMATION__: JSON.stringify(automation), __BUILD_ID__: JSON.stringify(buildId), __APP_VERSION__: JSON.stringify(packageMetadata.version) },
    server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin' } },
    build: { chunkSizeWarningLimit: 4096, target: 'es2020' },
  };
});
