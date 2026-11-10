// Zero-dependency server for the Ape Squad map marker tool.
// Serves the UI, the map images, and persists per-map data to data/map-data.json.
//   node app/server.js            -> http://localhost:5173
//   PORT=8080 node app/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5173;
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MAP_DIR = path.join(APP_DIR, '..', 'ape_squad_map');
const DATA_FILE = path.join(APP_DIR, 'data', 'map-data.json');

// POI palette. `icon` is an image in MAP_DIR (excluded from the map list);
// `appIcon` is a file under public/icons/.
const POI_TYPES = [
  { id: 'cash_box', label: 'Cash Box', icon: 'cash_box.png' },
  { id: 'cashout_station', label: 'Cashout Station', icon: 'cashout_station.png' },
  { id: 'spawn', label: 'Spawn', appIcon: 'spawn.svg' },
];

// Secondary icons attached to a POI; only shown while that POI is selected.
const SECONDARY_TYPES = [
  { id: 'high_ground', label: 'High Ground', appIcon: 'high_ground.svg' },
];

const typesForClient = (types) =>
  types.map(({ icon, appIcon, ...t }) => ({
    ...t,
    src: icon ? '/images/' + encodeURIComponent(icon) : '/icons/' + encodeURIComponent(appIcon),
  }));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, JSON.stringify({ error: 'not found' }));
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

// Resolve a URL path inside a root dir, refusing anything that escapes it.
function safeJoin(root, urlPath) {
  const file = path.normalize(path.join(root, urlPath));
  return file.startsWith(root + path.sep) ? file : null;
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { version: 1, maps: {} };
  }
}

function writeData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function listMaps() {
  const icons = new Set([...POI_TYPES, ...SECONDARY_TYPES].map((t) => t.icon).filter(Boolean));
  return fs
    .readdirSync(MAP_DIR)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()) && !icons.has(f))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ id: file, name: path.parse(file).name, file }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/config' && req.method === 'GET') {
    const config = {
      maps: listMaps(),
      poiTypes: typesForClient(POI_TYPES),
      secondaryTypes: typesForClient(SECONDARY_TYPES),
    };
    return send(res, 200, JSON.stringify(config));
  }

  if (pathname === '/api/data' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(readData()));
  }

  if (pathname === '/api/data' && req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data || typeof data.maps !== 'object') throw new Error('missing "maps"');
        writeData(data);
        send(res, 200, JSON.stringify({ ok: true }));
      } catch (e) {
        send(res, 400, JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname.startsWith('/images/')) {
    const file = safeJoin(MAP_DIR, pathname.slice('/images/'.length));
    return file ? sendFile(res, file) : send(res, 403, '{"error":"forbidden"}');
  }

  const file = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  return file ? sendFile(res, file) : send(res, 403, '{"error":"forbidden"}');
});

server.listen(PORT, () => {
  console.log(`Ape Squad map tool: http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
