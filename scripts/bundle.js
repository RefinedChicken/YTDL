#!/usr/bin/env node
// Bundles server.js + node_modules into a single file for Node SEA.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const outDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });

esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'server.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(outDir, 'bundle.js'),
  // These are dynamically required at runtime by archiver internals;
  // marking external prevents bundling failures on optional native paths.
  external: ['cpu-features', 'ssh2'],
  define: {
    // Suppress warnings about dynamic require in bundled output
    'process.env.ESBUILD_BUNDLE': '"1"',
  },
  logLevel: 'info',
}).catch(() => process.exit(1));
