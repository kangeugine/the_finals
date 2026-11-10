// Builds a read-only static copy of the map tool for GitHub Pages.
//   node app/build-static.js            -> _site/
//   node app/build-static.js out/dir
// The app falls back to config.json / map-data.json when there's no /api.

const fs = require('fs');
const path = require('path');
const { buildConfig, PUBLIC_DIR, MAP_DIR, DATA_FILE } = require('./server');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', '_site'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(PUBLIC_DIR, OUT, { recursive: true });

const config = { ...buildConfig(), readOnly: true };
const images = [
  ...config.maps.map((m) => m.file),
  ...[...config.poiTypes, ...config.secondaryTypes]
    .filter((t) => t.src.startsWith('images/'))
    .map((t) => decodeURIComponent(t.src.slice('images/'.length))),
];
fs.mkdirSync(path.join(OUT, 'images'));
for (const file of images) fs.copyFileSync(path.join(MAP_DIR, file), path.join(OUT, 'images', file));

fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(config));
fs.copyFileSync(DATA_FILE, path.join(OUT, 'map-data.json'));

console.log(`Built ${config.maps.length} maps, ${images.length} images -> ${OUT}`);
