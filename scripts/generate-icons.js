#!/usr/bin/env node
// Generates src-tauri/icons/icon.png (1024x1024) from the app SVG.
// Requires: npm install @resvg/resvg-js (dev dependency)
// After running this, execute: npx @tauri-apps/cli@latest icon src-tauri/icons/icon.png
const path = require('path');
const fs = require('fs');

const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

const svgSource = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">
  <rect width="100" height="100" rx="18" fill="#e8ff47"/>
  <rect x="30" y="25" width="40" height="30" rx="4" fill="#000"/>
  <polygon points="25,60 75,60 50,82" fill="#000"/>
  <rect x="22" y="84" width="56" height="6" rx="3" fill="#000"/>
</svg>
`;

async function main() {
  let Resvg;
  try {
    ({ Resvg } = require('@resvg/resvg-js'));
  } catch {
    console.error('@resvg/resvg-js not found. Run: npm install');
    process.exit(1);
  }

  const resvg = new Resvg(svgSource, { fitTo: { mode: 'width', value: 1024 } });
  const png = resvg.render().asPng();

  const outPath = path.join(iconsDir, 'icon.png');
  fs.writeFileSync(outPath, png);

  console.log(`Icon written to ${outPath}`);
  console.log('Now run: npx @tauri-apps/cli@latest icon src-tauri/icons/icon.png');
}

main().catch(err => { console.error(err); process.exit(1); });
