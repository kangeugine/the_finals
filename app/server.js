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
const MAP_DIR = path.join(APP_DIR, '..', 'maps', 'ape_squad_map');
const DATA_FILE = path.join(APP_DIR, 'data', 'map-data.json');
// Photos attached to POIs / secondary icons (resized in the browser before upload).
const PHOTO_DIR = path.join(APP_DIR, 'data', 'photos');
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
// VOD review: videos in vod_review/ are streamed to the browser. Each reviewed
// video's timestamps live in map-data.json (`vods`) and are also written next to
// the video as a YouTube-style <video name>.txt.
const VOD_DIR = path.join(APP_DIR, '..', 'vod_review');
const VOD_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

// POI palette. `icon` is an image in MAP_DIR (excluded from the map list);
// `appIcon` is a file under public/icons/.
const POI_TYPES = [
  { id: 'cash_box', label: 'Cash Box', icon: 'cash_box.png' },
  { id: 'cashout_station', label: 'Cashout Station', icon: 'cashout_station.png' },
  { id: 'spawn', label: 'Spawn', appIcon: 'spawn.svg' },
];

// Secondary icons attached to a POI; only shown while that POI is selected.
// `textField` adds a multi-line text box (saved as the icon's `text`) with that label.
const SECONDARY_TYPES = [
  { id: 'high_ground', label: 'High Ground', appIcon: 'high_ground.svg' },
  { id: 'duel', label: '1:1 Duel', appIcon: 'duel.svg' },
  { id: 'question', label: 'Question', appIcon: 'question.svg', textField: 'Question' },
];

const typesForClient = (types) =>
  types.map(({ icon, appIcon, ...t }) => ({
    ...t,
    src: icon ? 'images/' + encodeURIComponent(icon) : 'icons/' + encodeURIComponent(appIcon),
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
  // Zones are written by tools/zones/build.js, never by the UI: keep the ones on
  // disk so a tab loaded before a rebuild can't wipe them when it autosaves.
  const onDisk = readData();
  for (const [id, m] of Object.entries(onDisk.maps || {})) {
    if (!data.maps[id]) data.maps[id] = m;
    else if (m.zones) data.maps[id].zones = m.zones;
  }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  writeVodTxts(data.vods || {});
}

// "MM:SS", or "H:MM:SS" once the video is an hour or longer (YouTube's format).
function fmtTimestamp(t, duration) {
  const s = Math.floor(t);
  const mmss = String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  return duration >= 3600 ? Math.floor(s / 3600) + ':' + mmss : mmss;
}

const vodTxtPath = (file) => path.join(VOD_DIR, path.parse(path.basename(file)).name + '.txt');

function writeVodTxts(vods) {
  if (!fs.existsSync(VOD_DIR)) return;
  for (const [file, v] of Object.entries(vods)) {
    const lines = [...(v.timestamps || [])]
      .sort((a, b) => a.t - b.t)
      .map((ts) => `${fmtTimestamp(ts.t, v.duration)} ${(ts.text || '').replace(/\s+/g, ' ').trim()}`);
    const txt = [`${fmtTimestamp(0, v.duration)} Start`, ...lines].join('\n') + '\n';
    const out = vodTxtPath(file);
    let current = null;
    try {
      current = fs.readFileSync(out, 'utf8');
    } catch {}
    if (current !== txt) fs.writeFileSync(out, txt);
  }
}

// Videos in vod_review/, with the text of an existing .txt so timestamps written
// by hand (or before this tool) can be imported.
function listVods() {
  if (!fs.existsSync(VOD_DIR)) return [];
  return fs
    .readdirSync(VOD_DIR)
    .filter((f) => VOD_MIME[path.extname(f).toLowerCase()])
    .sort((a, b) => b.localeCompare(a)) // date-prefixed names: newest first
    .map((file) => {
      let txt = null;
      try {
        txt = fs.readFileSync(vodTxtPath(file), 'utf8');
      } catch {}
      return { file, name: path.parse(file).name, size: fs.statSync(path.join(VOD_DIR, file)).size, txt };
    });
}

// Videos are large, so honour Range requests (the <video> element seeks with them).
function streamVideo(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, '{"error":"not found"}');
    const type = VOD_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file).pipe(res);
    }
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]); // "bytes=-N" is the last N bytes
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

function listMaps() {
  const icons = new Set([...POI_TYPES, ...SECONDARY_TYPES].map((t) => t.icon).filter(Boolean));
  return fs
    .readdirSync(MAP_DIR)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()) && !icons.has(f))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ id: file, name: path.parse(file).name, file }));
}

// Also used by build-static.js, which adds `readOnly: true` for GitHub Pages.
function buildConfig() {
  return {
    maps: listMaps(),
    poiTypes: typesForClient(POI_TYPES),
    secondaryTypes: typesForClient(SECONDARY_TYPES),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/config' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(buildConfig()));
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

  // Upload: raw image bytes, ?ext=jpg. Returns { file } to store on the POI.
  if (pathname === '/api/photos' && req.method === 'POST') {
    const ext = '.' + (url.searchParams.get('ext') || 'jpg').toLowerCase();
    if (!PHOTO_EXT.has(ext)) return send(res, 400, '{"error":"unsupported image type"}');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_PHOTO_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const file = Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + ext;
      fs.mkdirSync(PHOTO_DIR, { recursive: true });
      fs.writeFileSync(path.join(PHOTO_DIR, file), Buffer.concat(chunks));
      send(res, 200, JSON.stringify({ file }));
    });
    return;
  }

  if (pathname.startsWith('/api/photos/') && req.method === 'DELETE') {
    const file = safeJoin(PHOTO_DIR, pathname.slice('/api/photos/'.length));
    if (!file) return send(res, 403, '{"error":"forbidden"}');
    fs.rm(file, { force: true }, () => send(res, 200, '{"ok":true}'));
    return;
  }

  if (pathname === '/api/vods' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(listVods()));
  }

  if (pathname.startsWith('/vods/')) {
    const file = safeJoin(VOD_DIR, pathname.slice('/vods/'.length));
    return file ? streamVideo(req, res, file) : send(res, 403, '{"error":"forbidden"}');
  }

  if (pathname.startsWith('/photos/')) {
    const file = safeJoin(PHOTO_DIR, pathname.slice('/photos/'.length));
    return file ? sendFile(res, file) : send(res, 403, '{"error":"forbidden"}');
  }

  if (pathname.startsWith('/images/')) {
    const file = safeJoin(MAP_DIR, pathname.slice('/images/'.length));
    return file ? sendFile(res, file) : send(res, 403, '{"error":"forbidden"}');
  }

  const file = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  return file ? sendFile(res, file) : send(res, 403, '{"error":"forbidden"}');
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Ape Squad map tool: http://localhost:${PORT}`);
    console.log(`Data file: ${DATA_FILE}`);
    console.log(`VODs: ${VOD_DIR}`);
  });
}

module.exports = { buildConfig, PUBLIC_DIR, MAP_DIR, DATA_FILE, PHOTO_DIR };
