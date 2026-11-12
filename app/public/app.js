'use strict';

// ---------------------------------------------------------------------------
// Coordinate spaces
//   image : source pixels. (0,0) top-left, y down. POIs are stored here so they
//           never drift when the north rotation is adjusted.
//   frame : the image rotated so north is up, centred on the image centre.
//           y down, units are still image pixels.
//   grid  : the user-facing system. (0,0) = south-west corner of the north-up
//           map, (gridW, gridH) = north-east corner. y up.
//   screen: CSS pixels on the canvas. screen = pan + zoom * frame.
// ---------------------------------------------------------------------------

const DEFAULT_ICON_SIZE = 34;
const SAVE_DEBOUNCE_MS = 400;
const NICE_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
const MEASURE_COLOR = '#3cc8ff';
const CHILD_COLOR = '#c77dff';
const CHILD_SCALE = 0.75; // secondary icon size relative to POI icons

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  maps: [],
  poiTypes: [],
  secondaryTypes: [],
  poiIcons: {},          // type id -> HTMLImageElement
  data: { version: 1, maps: {} },
  currentId: null,
  img: null,             // loaded HTMLImageElement for the current map
  imgCache: {},
  view: { zoom: 1, panX: 0, panY: 0 },
  tool: 'select',
  selectedPoi: null,
  selectedChild: null,   // a secondary icon of selectedPoi
  hoverPoi: null,        // POI or secondary icon under the cursor
  measure: { a: null, b: null }, // POIs picked with the measure tool
  cursor: null,          // last pointer position in screen px
  drag: null,
  showGrid: true,
  readOnly: false,       // GitHub Pages build: view only, nothing is saved
};

// ----------------------------- persistence --------------------------------

let saveTimer = null;

function scheduleSave() {
  if (state.readOnly) return;
  setSaveState('Unsaved…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save() {
  try {
    const res = await fetch('api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.data),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    setSaveState('Saved');
  } catch (e) {
    setSaveState('Save failed: ' + e.message, true);
  }
}

function setSaveState(text, isError = false) {
  const el = $('save-state');
  el.textContent = text;
  el.classList.toggle('save-error', isError);
}

function mapData(id = state.currentId) {
  if (!state.data.maps[id]) {
    state.data.maps[id] = { rotation: 0, northLocked: false, gridSpacing: 'auto', pois: [] };
  }
  state.data.maps[id].distanceRefs ??= [];
  return state.data.maps[id];
}

// Display settings shared by every map.
function settings() {
  return (state.data.settings ??= { iconSize: DEFAULT_ICON_SIZE, hiddenTypes: [] });
}

const isVisible = (p) => !settings().hiddenTypes.includes(p.type);
const visiblePois = () => mapData().pois.filter(isVisible);
const poiById = (id) => mapData().pois.find((p) => p.id === id);

// "Cash Box 2" style names so unlabeled POIs of the same type can be told apart.
function poiName(p) {
  if (p.label) return p.label;
  const t = state.poiTypes.find((t) => t.id === p.type);
  const sameType = mapData().pois.filter((q) => q.type === p.type);
  return `${t?.label || p.type} ${sameType.indexOf(p) + 1}`;
}

// ------------------------- secondary icons --------------------------------
// A POI's `children` are secondary icons (e.g. High Ground) stored in image
// px like their parent. They're only drawn while the parent is selected and
// move with the parent when it's dragged.

const CHILD_TOOL_PREFIX = 'child:';
const children = (p) => (p.children ??= []);
const secondaryType = (id) => state.secondaryTypes.find((t) => t.id === id);
const activeItem = () => state.selectedChild || state.selectedPoi;

function childName(parent, c) {
  if (c.label) return c.label;
  const sameType = children(parent).filter((q) => q.type === c.type);
  return `${secondaryType(c.type)?.label || c.type} ${sameType.indexOf(c) + 1}`;
}

// Move a POI (dragging its children along) or a single child to a new image position.
function moveItem(item, isChild, u, v) {
  const next = { x: round1(u), y: round1(v) };
  if (!isChild) {
    const dx = next.x - item.imagePos.x;
    const dy = next.y - item.imagePos.y;
    for (const c of children(item)) c.imagePos = { x: round1(c.imagePos.x + dx), y: round1(c.imagePos.y + dy) };
  }
  item.imagePos = next;
}

// ------------------------------ distance ----------------------------------
// Distances are measured in image pixels (rotation-invariant, identical to grid
// units). Known distances between POI pairs calibrate a per-map metres/pixel
// scale via least squares through the origin: k = Σ(d·p) / Σ(p²).

const pxDist = (a, b) => Math.hypot(a.imagePos.x - b.imagePos.x, a.imagePos.y - b.imagePos.y);

function resolvedRefs() {
  return mapData()
    .distanceRefs.map((r) => ({ ref: r, a: poiById(r.a), b: poiById(r.b) }))
    .filter((r) => r.a && r.b && pxDist(r.a, r.b) > 0);
}

function distanceScale() {
  const refs = resolvedRefs();
  if (!refs.length) return null;
  let num = 0;
  let den = 0;
  for (const { ref, a, b } of refs) {
    const p = pxDist(a, b);
    num += ref.meters * p;
    den += p * p;
  }
  return { mPerPx: num / den, count: refs.length };
}

function findRef(a, b) {
  return mapData().distanceRefs.find(
    (r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id),
  );
}

const fmtMeters = (m) => (m >= 100 ? Math.round(m) : m.toFixed(1)) + ' m';

function distanceText(px, ref, scale = distanceScale()) {
  if (ref) return `${fmtMeters(ref.meters)} (known)`;
  if (scale) return `≈ ${fmtMeters(px * scale.mPerPx)}`;
  return `${Math.round(px)} px`;
}

// ------------------------------ geometry ----------------------------------

function geometry() {
  const m = mapData();
  const W = state.img.naturalWidth;
  const H = state.img.naturalHeight;
  const rad = (m.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Snap tiny float noise so 90° rotations give exact W/H swaps.
  const ac = Math.abs(cos) < 1e-9 ? 0 : Math.abs(cos);
  const as = Math.abs(sin) < 1e-9 ? 0 : Math.abs(sin);
  return { W, H, cos, sin, rad, gridW: W * ac + H * as, gridH: W * as + H * ac };
}

function imageToFrame(g, u, v) {
  const dx = u - g.W / 2;
  const dy = v - g.H / 2;
  return { x: dx * g.cos - dy * g.sin, y: dx * g.sin + dy * g.cos };
}

function frameToImage(g, x, y) {
  return { u: x * g.cos + y * g.sin + g.W / 2, v: -x * g.sin + y * g.cos + g.H / 2 };
}

const frameToGrid = (g, x, y) => ({ x: x + g.gridW / 2, y: g.gridH / 2 - y });
const gridToFrame = (g, gx, gy) => ({ x: gx - g.gridW / 2, y: g.gridH / 2 - gy });

const frameToScreen = (x, y) => ({
  x: state.view.panX + state.view.zoom * x,
  y: state.view.panY + state.view.zoom * y,
});
const screenToFrame = (sx, sy) => ({
  x: (sx - state.view.panX) / state.view.zoom,
  y: (sy - state.view.panY) / state.view.zoom,
});

function imageToGrid(g, u, v) {
  const f = imageToFrame(g, u, v);
  return frameToGrid(g, f.x, f.y);
}

function gridToImage(g, gx, gy) {
  const f = gridToFrame(g, gx, gy);
  return frameToImage(g, f.x, f.y);
}

const round1 = (n) => Math.round(n * 10) / 10;

// Refresh the grid-space values stored alongside image-space data so the saved
// JSON is directly usable without re-deriving the rotation math.
function syncDerived() {
  const m = mapData();
  const g = geometry();
  m.imageSize = { width: g.W, height: g.H };
  m.gridSize = { width: round1(g.gridW), height: round1(g.gridH) };
  for (const p of m.pois) {
    for (const item of [p, ...children(p)]) {
      const gp = imageToGrid(g, item.imagePos.x, item.imagePos.y);
      item.gridPos = { x: round1(gp.x), y: round1(gp.y) };
    }
  }
}

// ------------------------------ rendering ---------------------------------

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = canvas;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
}

let rafPending = false;
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    draw();
  });
}

function draw() {
  resizeCanvas();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.img) return;

  const g = geometry();
  const { zoom, panX, panY } = state.view;

  // Map image, rotated about its centre into the north-up frame.
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
  ctx.save();
  ctx.rotate(g.rad);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.img, -g.W / 2, -g.H / 2);
  ctx.restore();

  drawZones(g, dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.showGrid) drawGrid(g);
  drawMeasure(g);
  drawPois(g);
}

// Zones (from tools/zones/build.js) are polygons in image px, drawn in the
// image's own transform; their names are drawn upright in screen space.
function drawZones(g, dpr) {
  const zones = mapData().zones;
  if (!zones?.length || settings().showZones === false) return;
  const { zoom, panX, panY } = state.view;
  ctx.save();
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
  ctx.rotate(g.rad);
  ctx.translate(-g.W / 2, -g.H / 2);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2 / zoom;
  zones.forEach((z, i) => {
    const hue = (i * 137.5) % 360;
    ctx.beginPath();
    for (const poly of z.polygons) {
      poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
    ctx.fillStyle = `hsla(${hue}, 85%, 55%, 0.14)`;
    ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 0.9)`;
    ctx.fill('evenodd'); // a ring inside another is a hole
    ctx.stroke();
  });
  ctx.restore();

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.fillStyle = '#fff';
  for (const z of zones) {
    const f = imageToFrame(g, z.label.x, z.label.y);
    const s = frameToScreen(f.x, f.y);
    ctx.strokeText(z.name, s.x, s.y);
    ctx.fillText(z.name, s.x, s.y);
  }
  ctx.restore();
}

function gridStep() {
  const setting = mapData().gridSpacing;
  if (setting !== 'auto') return Number(setting);
  const minScreenGap = 70;
  return NICE_STEPS.find((s) => s * state.view.zoom >= minScreenGap) ?? NICE_STEPS.at(-1);
}

function drawGrid(g) {
  const step = gridStep();
  const sw = frameToScreen(-g.gridW / 2, g.gridH / 2);   // south-west, screen
  const ne = frameToScreen(g.gridW / 2, -g.gridH / 2);   // north-east, screen
  const left = sw.x, bottom = sw.y, right = ne.x, top = ne.y;
  const z = state.view.zoom;

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  for (let gx = step; gx < g.gridW; gx += step) {
    const x = Math.round(left + gx * z) + 0.5;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let gy = step; gy < g.gridH; gy += step) {
    const y = Math.round(bottom - gy * z) + 0.5;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(245,197,24,0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left, top, right - left, bottom - top);

  // Axis labels, pinned inside the viewport so they stay readable when zoomed in.
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight - 30; // leave room for the status bar
  const labelY = Math.min(Math.max(bottom - 4, 14), vh - 4);
  const labelX = Math.min(Math.max(left + 4, 4), vw - 40);

  ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 3;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let gx = step; gx < g.gridW; gx += step) {
    const x = left + gx * z;
    if (x > 30 && x < vw - 30) ctx.fillText(gx, x, labelY);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let gy = step; gy < g.gridH; gy += step) {
    const y = bottom - gy * z;
    if (y > 20 && y < vh - 20) ctx.fillText(gy, labelX, y);
  }

  ctx.fillStyle = 'rgba(245,197,24,1)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('(0, 0) SW', left + 4, bottom + 4);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`NE (${Math.round(g.gridW)}, ${Math.round(g.gridH)})`, right - 4, top - 4);
  ctx.shadowBlur = 0;
}

function poiScreenPos(g, p) {
  const f = imageToFrame(g, p.imagePos.x, p.imagePos.y);
  return frameToScreen(f.x, f.y);
}

function drawLabel(text, x, y, color) {
  ctx.font = '600 11px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(17,19,23,0.85)';
  ctx.fillRect(x - w / 2, y, w, 17);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 3);
}

function drawPois(g) {
  const r = settings().iconSize / 2;
  const { a: ma, b: mb } = state.measure;
  const parent = state.selectedPoi && isVisible(state.selectedPoi) ? state.selectedPoi : null;

  // Tethers from the selected POI to its secondary icons sit under everything.
  if (parent && children(parent).length) {
    const sp = poiScreenPos(g, parent);
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = CHILD_COLOR;
    ctx.beginPath();
    for (const c of children(parent)) {
      const sc = poiScreenPos(g, c);
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(sc.x, sc.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const p of visiblePois()) {
    const s = poiScreenPos(g, p);
    const selected = p === state.selectedPoi;
    const hover = p === state.hoverPoi;
    const measured = p === ma || p === mb;
    const ring = measured ? MEASURE_COLOR
      : selected ? '#f5c518'
      : hover ? '#ffffff'
      : 'rgba(255,255,255,0.5)';
    drawIcon(p, s, r, ring, selected || measured ? 3 : 1.5);

    if (selected || hover || p.label) {
      const gp = imageToGrid(g, p.imagePos.x, p.imagePos.y);
      const text = (p.label ? p.label + '  ' : '') + `(${Math.round(gp.x)}, ${Math.round(gp.y)})`;
      drawLabel(text, s.x, s.y + r + 4, selected ? '#f5c518' : '#fff');
    }
  }

  if (!parent) return;
  const cr = r * CHILD_SCALE;
  for (const c of children(parent)) {
    const s = poiScreenPos(g, c);
    const selected = c === state.selectedChild;
    const hover = c === state.hoverPoi;
    drawIcon(c, s, cr, selected ? '#f5c518' : hover ? '#ffffff' : CHILD_COLOR, selected ? 3 : 2);
    if (selected || hover || c.label) {
      drawLabel(childName(parent, c), s.x, s.y + cr + 4, selected ? '#f5c518' : CHILD_COLOR);
    }
    if ((selected || hover) && c.text) drawNote(c.text, s.x, s.y + cr + 24);
  }
}

// Multi-line text (e.g. a Question icon's text), wrapped, in a box below the icon.
function drawNote(text, x, y) {
  const MAX_W = 260, LINE = 15, PAD = 6;
  ctx.font = '500 12px -apple-system, system-ui, sans-serif';
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (line && ctx.measureText(next).width > MAX_W) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + PAD * 2;
  const h = lines.length * LINE + PAD * 2 - 3;
  ctx.fillStyle = 'rgba(17,19,23,0.92)';
  ctx.fillRect(x - w / 2, y, w, h);
  ctx.strokeStyle = CHILD_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2 + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x - w / 2 + PAD, y + PAD + i * LINE));
}

function drawIcon(item, s, r, ring, ringWidth) {
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(17,19,23,0.75)';
  ctx.fill();
  ctx.lineWidth = ringWidth;
  ctx.strokeStyle = ring;
  ctx.stroke();

  const icon = state.poiIcons[item.type];
  if (icon?.complete) {
    const size = r * 1.5;
    ctx.drawImage(icon, s.x - size / 2, s.y - size / 2, size, size);
  }
}

function drawMeasure(g) {
  if (state.tool !== 'measure') return;
  const scale = distanceScale();

  // Saved references, faint, so it's clear what the scale is built from.
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(60,200,255,0.45)';
  for (const { ref, a, b } of resolvedRefs()) {
    if (!isVisible(a) || !isVisible(b)) continue;
    const sa = poiScreenPos(g, a);
    const sb = poiScreenPos(g, b);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    drawLabel(fmtMeters(ref.meters), (sa.x + sb.x) / 2, (sa.y + sb.y) / 2 - 8, 'rgba(60,200,255,0.8)');
  }
  ctx.setLineDash([]);

  const { a, b } = state.measure;
  if (!a) return;
  const sa = poiScreenPos(g, a);
  let end;
  let text;
  if (b) {
    end = poiScreenPos(g, b);
    text = distanceText(pxDist(a, b), findRef(a, b), scale);
  } else if (state.cursor) {
    // Live line from A to the cursor, for estimating to any spot on the map.
    end = state.cursor;
    const f = screenToFrame(end.x, end.y);
    const ip = frameToImage(g, f.x, f.y);
    text = distanceText(Math.hypot(ip.u - a.imagePos.x, ip.v - a.imagePos.y), null, scale);
  } else {
    return;
  }
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = MEASURE_COLOR;
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  drawLabel(text, (sa.x + end.x) / 2, (sa.y + end.y) / 2 - 8, MEASURE_COLOR);
}

// ------------------------------ view control ------------------------------

function fitView() {
  if (!state.img) return;
  const g = geometry();
  const pad = 40;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight - 30;
  const zoom = Math.min((w - pad * 2) / g.gridW, (h - pad * 2) / g.gridH);
  state.view = { zoom, panX: w / 2, panY: h / 2 };
  updateStatus();
  render();
}

function zoomAt(sx, sy, factor) {
  const v = state.view;
  const next = Math.min(Math.max(v.zoom * factor, 0.02), 20);
  const f = screenToFrame(sx, sy);
  v.zoom = next;
  v.panX = sx - f.x * next;
  v.panY = sy - f.y * next;
  updateStatus();
  render();
}

// ------------------------------ map loading -------------------------------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load ' + src));
    img.src = src;
  });
}

async function selectMap(id) {
  state.currentId = id;
  state.selectedPoi = null;
  state.selectedChild = null;
  state.hoverPoi = null;
  state.measure = { a: null, b: null };
  if (state.tool.startsWith(CHILD_TOOL_PREFIX)) setTool('select');
  localStorage.setItem('lastMap', id);
  vodMapChanged(id);
  renderMapList();
  renderPhotos();

  const map = state.maps.find((m) => m.id === id);
  $('loading').hidden = false;
  state.img = null;
  render();
  try {
    state.img = state.imgCache[id] ??= await loadImage('images/' + encodeURIComponent(map.file));
  } catch (e) {
    $('loading').textContent = e.message;
    return;
  }
  if (state.currentId !== id) return; // user switched maps while loading
  $('loading').hidden = true;

  syncDerived();
  syncControls();
  fitView();
}

// ------------------------------ UI binding --------------------------------

function renderMapList() {
  const list = $('map-list');
  list.innerHTML = '';
  for (const map of state.maps) {
    const d = state.data.maps[map.id];
    const li = document.createElement('li');
    li.classList.toggle('active', map.id === state.currentId);
    const n = d?.pois?.length || 0;
    li.innerHTML = `<span></span><span class="meta">${d?.northLocked ? '🔒 ' : ''}${n ? n + ' POI' : ''}</span>`;
    li.firstChild.textContent = map.name;
    li.onclick = () => selectMap(map.id);
    list.appendChild(li);
  }
}

function renderTools() {
  const tools = $('tools');
  state.poiTypes.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'tool';
    btn.dataset.tool = t.id;
    btn.title = `Place ${t.label} (${i + 1})`;
    btn.innerHTML = `<img alt="" /><span></span><kbd>${i + 1}</kbd>`;
    btn.querySelector('img').src = t.src;
    btn.querySelector('span').textContent = t.label;
    tools.appendChild(btn);
  });
  tools.onclick = (e) => {
    const btn = e.target.closest('.tool');
    if (btn) setTool(btn.dataset.tool);
  };
  document.querySelector('.tool[data-tool="measure"]').onclick = () =>
    setTool(state.tool === 'measure' ? 'select' : 'measure');

  const childTools = $('child-tools');
  for (const t of state.secondaryTypes) {
    const btn = document.createElement('button');
    btn.className = 'tool';
    btn.dataset.tool = CHILD_TOOL_PREFIX + t.id;
    btn.title = `Click the map to add ${t.label} to the selected POI`;
    btn.innerHTML = '<img alt="" /><span></span><span class="tool-icon">＋</span>';
    btn.querySelector('img').src = t.src;
    btn.querySelector('span').textContent = t.label;
    childTools.appendChild(btn);
  }
  childTools.onclick = (e) => {
    const btn = e.target.closest('.tool');
    if (btn) setTool(state.tool === btn.dataset.tool ? 'select' : btn.dataset.tool);
  };
}

function setTool(tool) {
  if (tool.startsWith(CHILD_TOOL_PREFIX) && !state.selectedPoi) tool = 'select';
  state.tool = tool;
  if (tool === 'select' || tool === 'measure') vod.linkNext = false;
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
  canvas.classList.toggle('placing', tool !== 'select' && tool !== 'measure');
  // Placing a hidden type would make it vanish on click, so reveal it.
  if (settings().hiddenTypes.includes(tool)) setTypeVisible(tool, true);
  if (tool === 'measure') selectPoi(null);
  renderDistance();
  render();
}

function renderDisplay() {
  const s = settings();
  $('icon-size').value = s.iconSize;
  $('icon-size-val').textContent = s.iconSize + 'px';
  $('zones-toggle').checked = s.showZones !== false;
  $('zones-toggle').disabled = !(state.img && mapData().zones?.length);

  const list = $('type-filters');
  list.innerHTML = '';
  const pois = state.img ? mapData().pois : [];
  for (const t of state.poiTypes) {
    const li = document.createElement('li');
    li.innerHTML = '<label><input type="checkbox" /><img alt="" /><span></span><span class="count"></span></label>';
    const cb = li.querySelector('input');
    cb.checked = !s.hiddenTypes.includes(t.id);
    cb.onchange = () => setTypeVisible(t.id, cb.checked);
    li.querySelector('img').src = t.src;
    li.querySelector('span').textContent = t.label;
    li.querySelector('.count').textContent = pois.filter((p) => p.type === t.id).length;
    list.appendChild(li);
  }
}

function setZonesVisible(visible) {
  settings().showZones = visible;
  $('zones-toggle').checked = visible;
  render();
  scheduleSave();
}

function setTypeVisible(typeId, visible) {
  const s = settings();
  s.hiddenTypes = s.hiddenTypes.filter((id) => id !== typeId);
  if (!visible) s.hiddenTypes.push(typeId);

  if (state.selectedPoi && !isVisible(state.selectedPoi)) {
    state.selectedPoi = null;
    state.selectedChild = null;
    if (state.tool.startsWith(CHILD_TOOL_PREFIX)) state.tool = 'select';
  }
  const m = state.measure;
  if ((m.a && !isVisible(m.a)) || (m.b && !isVisible(m.b))) state.measure = { a: null, b: null };
  state.hoverPoi = null;

  renderDisplay();
  renderPoiList();
  renderSelected();
  renderDistance();
  render();
  scheduleSave();
}

function renderDistance() {
  if (!state.img) return;
  const scale = distanceScale();
  const pill = $('scale-state');
  pill.textContent = scale
    ? `${scale.mPerPx.toFixed(3)} m/px · ${scale.count} ref${scale.count > 1 ? 's' : ''}`
    : 'not calibrated';
  pill.classList.toggle('locked', !!scale);

  const measuring = state.tool === 'measure';
  const { a, b } = state.measure;
  $('measure-hint').textContent = !measuring
    ? 'Pick two POIs to measure.' + (state.readOnly ? '' : ' Enter a known distance to calibrate this map.')
    : !a
      ? 'Click the first POI.'
      : !b
        ? 'Click a second POI, or hover anywhere for a live estimate.'
        : 'Click another POI to start a new measurement. Esc to clear.';

  // Current pair.
  const showPair = measuring && a && b;
  $('measure-result').hidden = !showPair;
  if (showPair) {
    const px = pxDist(a, b);
    const ref = findRef(a, b);
    $('m-a').textContent = poiName(a);
    $('m-b').textContent = poiName(b);
    let html = ref ? `${fmtMeters(ref.meters)} <small>known</small>`
      : scale ? `≈ ${fmtMeters(px * scale.mPerPx)} <small>estimated</small>`
      : `— <small>enter a known distance to calibrate</small>`;
    if (ref && scale && resolvedRefs().length > 1) {
      html += ` <small>(fit: ${fmtMeters(px * scale.mPerPx)})</small>`;
    }
    $('m-value').innerHTML = html + `<br><small>${Math.round(px)} grid px</small>`;
    if (document.activeElement !== $('m-known')) $('m-known').value = ref ? ref.meters : '';
  }

  // Distances from A to every other visible POI, nearest first.
  const nearby = $('m-nearby');
  nearby.innerHTML = '';
  if (measuring && a && !b) {
    const others = visiblePois()
      .filter((p) => p !== a)
      .map((p) => ({ p, px: pxDist(a, p) }))
      .sort((x, y) => x.px - y.px)
      .slice(0, 10);
    for (const { p, px } of others) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="name"></span><span class="val"></span>';
      li.querySelector('.name').textContent = `${poiName(a)} → ${poiName(p)}`;
      li.querySelector('.val').textContent = distanceText(px, findRef(a, p), scale);
      li.onclick = () => measureClick(p);
      nearby.appendChild(li);
    }
  }

  // Reference list with each one's deviation from the fitted scale.
  const refs = resolvedRefs();
  const list = $('ref-list');
  list.innerHTML = '';
  $('ref-heading').hidden = !refs.length;
  for (const { ref, a: ra, b: rb } of refs) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><span class="val"></span><span class="dev"></span><button title="Remove reference">×</button>';
    li.querySelector('.name').textContent = `${poiName(ra)} → ${poiName(rb)}`;
    li.querySelector('.val').textContent = fmtMeters(ref.meters);
    if (refs.length > 1) {
      const dev = ((pxDist(ra, rb) * scale.mPerPx - ref.meters) / ref.meters) * 100;
      const el = li.querySelector('.dev');
      el.textContent = `${dev >= 0 ? '+' : ''}${dev.toFixed(0)}%`;
      el.title = 'How far the fitted scale is from this reference';
      el.classList.toggle('bad', Math.abs(dev) > 10);
    }
    li.querySelector('button').onclick = (e) => {
      e.stopPropagation();
      const m = mapData();
      m.distanceRefs = m.distanceRefs.filter((r) => r !== ref);
      renderDistance();
      render();
      scheduleSave();
    };
    li.onclick = () => {
      if (!isVisible(ra) || !isVisible(rb)) return;
      if (state.tool !== 'measure') setTool('measure');
      state.measure = { a: ra, b: rb };
      renderDistance();
      render();
    };
    list.appendChild(li);
  }
}

function measureClick(p) {
  const m = state.measure;
  if (!p) state.measure = { a: null, b: null };
  else if (!m.a || m.b) state.measure = { a: p, b: null };
  else if (p !== m.a) m.b = p;
  renderDistance();
  render();
}

function saveKnownDistance() {
  const { a, b } = state.measure;
  const meters = Number($('m-known').value);
  if (!a || !b || !(meters > 0)) return;
  const ref = findRef(a, b);
  if (ref) ref.meters = meters;
  else mapData().distanceRefs.push({ a: a.id, b: b.id, meters });
  $('m-known').blur();
  renderDistance();
  render();
  scheduleSave();
}

function syncControls() {
  const m = mapData();
  const g = geometry();
  $('rot-slider').value = m.rotation;
  $('rot-input').value = m.rotation;
  for (const el of document.querySelectorAll('#rot-slider, #rot-input, [data-rot]')) el.disabled = m.northLocked;

  const lockBtn = $('lock-btn');
  lockBtn.textContent = m.northLocked ? '🔒 North locked — click to unlock' : 'Lock north';
  lockBtn.classList.toggle('locked', m.northLocked);
  $('north-state').textContent = m.northLocked ? 'locked' : 'unlocked';
  $('north-state').classList.toggle('locked', m.northLocked);
  $('compass').classList.toggle('locked', m.northLocked);

  $('grid-spacing').value = m.gridSpacing;
  $('grid-info').textContent =
    `SW (0, 0) → NE (${Math.round(g.gridW)}, ${Math.round(g.gridH)})` +
    (m.northLocked ? '' : ' · lock north to freeze coordinates');

  renderPoiList();
  renderSelected();
  renderDisplay();
  renderDistance();
}

function renderPoiList() {
  const m = mapData();
  const pois = visiblePois();
  const list = $('poi-list');
  list.innerHTML = '';
  $('poi-count').textContent = pois.length === m.pois.length ? m.pois.length : `${pois.length} of ${m.pois.length} shown`;
  if (!pois.length) {
    list.innerHTML = `<li class="empty">${m.pois.length ? 'All hidden' : 'None yet'}</li>`;
    return;
  }
  const typeById = Object.fromEntries(state.poiTypes.map((t) => [t.id, t]));
  for (const p of pois) {
    const t = typeById[p.type];
    const li = document.createElement('li');
    li.classList.toggle('selected', p === state.selectedPoi);
    li.innerHTML = '<img alt="" /><span class="name"></span><span class="coords"></span>';
    if (t) li.querySelector('img').src = t.src;
    li.querySelector('.name').textContent = poiName(p);
    const kids = children(p).length;
    li.querySelector('.coords').textContent =
      `${Math.round(p.gridPos.x)}, ${Math.round(p.gridPos.y)}` + (kids ? ` · +${kids}` : '');
    li.onclick = () => selectPoi(p, true);
    list.appendChild(li);
  }
}

function renderSelected() {
  const p = state.selectedPoi;
  $('selected-panel').hidden = !p;
  renderPhotos();
  renderDraft();
  if (!p) return;
  const c = state.selectedChild;
  const item = c || p;
  const poiLabel = state.poiTypes.find((t) => t.id === p.type)?.label || p.type;

  $('selected-panel').querySelector('h2').textContent = c ? 'Selected secondary icon' : 'Selected POI';
  $('sel-type').textContent = c
    ? `${secondaryType(c.type)?.label || c.type} · on ${poiName(p)}`
    : poiLabel;
  $('sel-delete').textContent = c ? 'Delete secondary icon' : 'Delete POI';
  if (document.activeElement !== $('sel-x')) $('sel-x').value = Math.round(item.gridPos.x);
  if (document.activeElement !== $('sel-y')) $('sel-y').value = Math.round(item.gridPos.y);
  if (document.activeElement !== $('sel-label')) $('sel-label').value = item.label || '';
  // Types with a text field (e.g. Question) get a multi-line box for the icon's text.
  const textField = c && secondaryType(c.type)?.textField;
  $('sel-text-field').hidden = !textField;
  if (textField) {
    $('sel-text-label').textContent = textField;
    $('sel-text').placeholder = state.readOnly ? '' : `Write the ${textField.toLowerCase()}…`;
    if (document.activeElement !== $('sel-text')) $('sel-text').value = c.text || '';
  }

  const list = $('child-list');
  list.innerHTML = '';
  for (const k of children(p)) {
    const li = document.createElement('li');
    li.classList.toggle('selected', k === c);
    li.innerHTML = '<img alt="" /><span class="name"></span><span class="val"></span><button title="Remove">×</button>';
    li.querySelector('img').src = secondaryType(k.type)?.src || '';
    li.querySelector('.name').textContent = childName(p, k);
    li.querySelector('.val').textContent = `${Math.round(k.gridPos.x)}, ${Math.round(k.gridPos.y)}`;
    li.querySelector('button').onclick = (e) => {
      e.stopPropagation();
      deleteChild(p, k);
    };
    li.onclick = () => selectChild(k);
    list.appendChild(li);
  }

  // VOD timestamps linked to this POI (and its secondary icons) or to the selected secondary icon.
  const linked = linkedTimestamps(p, c);
  $('sel-ts').hidden = !linked.length;
  const tsList = $('sel-ts-list');
  tsList.innerHTML = '';
  for (const { file, ts } of linked) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="ts"></span><span class="name"></span>';
    li.querySelector('.ts').textContent = fmtTime(ts.t, vodEntry(file)?.duration);
    li.querySelector('.name').textContent = ts.text;
    const yt = youtubeUrl(file, ts.t);
    li.prepend(yt ? youtubeLink(file, ts.t) : Object.assign(document.createElement('span'), { className: 'yt-slot' }));
    li.title = file + ' — click to play in VOD review';
    li.onclick = () => playTimestamp(file, ts);
    tsList.appendChild(li);
  }
}

function selectPoi(p, center = false) {
  state.selectedPoi = p;
  state.selectedChild = null;
  if (!p && state.tool.startsWith(CHILD_TOOL_PREFIX)) setTool('select');
  if (p && center) {
    const s = poiScreenPos(geometry(), p);
    state.view.panX += canvas.clientWidth / 2 - s.x;
    state.view.panY += (canvas.clientHeight - 30) / 2 - s.y;
  }
  renderPoiList();
  renderSelected();
  render();
}

// ------------------------------- photos -----------------------------------
// Each POI / secondary icon can have `photos: [file]`, stored in app/data/photos
// by the server. The strip shows the selected POI's photos, then each of its
// secondary icons' photos (with that icon above the photo) — or, when a
// secondary icon is selected, only that icon's photos.

const PHOTO_MAX_PX = 1600;   // longest side after resizing in the browser
const PHOTO_QUALITY = 0.85;  // JPEG quality
const photoUrl = (file) => 'photos/' + encodeURIComponent(file);

function renderPhotos() {
  const p = state.selectedPoi;
  $('photo-strip').hidden = !p;
  if (!p) return;
  const target = activeItem();
  $('photo-target').textContent = 'Add photo to ' + (target === p ? poiName(p) : childName(p, target));

  const list = $('photo-list');
  list.innerHTML = '';
  // `head` labels the photo's owner: { text, icon?, onClick?, yt?: { file, t } }.
  // With no `file` the tile shows `head.note` (a timestamp's description) instead of a photo.
  const addTile = (item, file, head) => {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    if (head) {
      const h = document.createElement('div');
      h.className = 'photo-head';
      h.innerHTML = '<img alt="" /><span></span>';
      if (head.icon) h.querySelector('img').src = head.icon;
      else h.querySelector('img').remove();
      h.querySelector('span').textContent = head.text;
      if (head.onClick) {
        h.classList.add('link');
        h.title = 'Play in VOD review';
        h.onclick = (e) => {
          e.stopPropagation();
          head.onClick();
        };
      }
      if (head.yt) h.prepend(youtubeLink(head.yt.file, head.yt.t, head.yt.text));
      tile.appendChild(h);
    }
    if (!file) {
      const note = document.createElement('div');
      note.className = 'photo-note';
      note.textContent = head.note;
      tile.classList.add('note');
      tile.appendChild(note);
      if (head.onClick) tile.onclick = head.onClick;
      list.appendChild(tile);
      return;
    }
    const img = document.createElement('img');
    img.className = 'photo';
    img.loading = 'lazy';
    img.src = photoUrl(file);
    tile.appendChild(img);
    const del = document.createElement('button');
    del.className = 'photo-del';
    del.title = 'Remove photo';
    del.textContent = '×';
    del.onclick = (e) => {
      e.stopPropagation();
      removePhoto(item, file);
    };
    tile.appendChild(del);
    tile.onclick = () => openLightbox(file);
    list.appendChild(tile);
  };
  // A selected secondary icon shows just its own photos; the POI shows its own
  // plus all of its secondary icons'. VOD timestamps linked to an icon put their
  // YouTube link on that icon's photos (the first timestamp, if there are several);
  // a timestamp with screenshots shows those, and any other gets a text tile.
  const c = state.selectedChild;
  const pending = new Map(); // icon id -> its linked timestamps not shown yet
  for (const l of linkedTimestamps(p, c)) {
    const key = l.ts.link.child || l.ts.link.poi;
    pending.set(key, [...(pending.get(key) || []), l]);
  }
  const tsHead = ({ file: vodFile, ts }, base) => {
    const yt = youtubeUrl(vodFile, ts.t);
    return {
      ...base,
      note: ts.text,
      yt: yt && { file: vodFile, t: ts.t, text: ts.text },
      onClick: () => playTimestamp(vodFile, ts),
    };
  };
  const addItemPhotos = (item, base) => {
    if (!item.photos?.length) return;
    const l = pending.get(item.id)?.find((x) => !x.ts.photos?.length);
    if (l) pending.set(item.id, pending.get(item.id).filter((x) => x !== l));
    const head = l ? tsHead(l, base || { text: poiName(item), icon: state.poiTypes.find((t) => t.id === item.type)?.src }) : base;
    for (const file of item.photos) addTile(item, file, head);
  };
  const childHead = (k) => ({ icon: secondaryType(k.type)?.src, text: childName(p, k) });
  if (c) addItemPhotos(c, childHead(c));
  else {
    addItemPhotos(p, null);
    for (const k of children(p)) addItemPhotos(k, childHead(k));
  }
  for (const l of [...pending.values()].flat().sort((a, b) => a.ts.t - b.ts.t)) {
    const time = fmtTime(l.ts.t, vodEntry(l.file)?.duration);
    const base = { text: (youtubeUrl(l.file) ? '' : '▶ ') + time + (l.ts.photos?.length ? ' ' + l.ts.text : '') };
    if (l.ts.photos?.length) for (const file of l.ts.photos) addTile(l.ts, file, tsHead(l, base));
    else addTile(l.ts, null, tsHead(l, base));
  }
}

// Resize to PHOTO_MAX_PX (keeps the repo / Pages site small) and re-encode as JPEG.
// `file` is anything createImageBitmap takes: a File, or the <video> for a screenshot.
async function resizePhoto(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, PHOTO_MAX_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode image'))), 'image/jpeg', PHOTO_QUALITY));
}

// Upload a JPEG blob; returns the stored file name.
async function uploadPhoto(blob) {
  const res = await fetch('api/photos?ext=jpg', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return (await res.json()).file;
}

const deletePhotoFile = (file) => fetch('api/photos/' + encodeURIComponent(file), { method: 'DELETE' }).catch(() => {});

async function uploadPhotos(files) {
  const target = activeItem();
  if (state.readOnly || !target) return;
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  const tile = $('photo-upload');
  tile.classList.add('busy');
  try {
    for (const [i, f] of images.entries()) {
      setSaveState(`Uploading photo ${i + 1}/${images.length}…`);
      const file = await uploadPhoto(await resizePhoto(f));
      (target.photos ??= []).push(file);
      renderPhotos();
    }
    scheduleSave();
  } catch (e) {
    setSaveState('Photo upload failed: ' + e.message, true);
  } finally {
    tile.classList.remove('busy');
  }
}

function removePhoto(item, file) {
  item.photos = (item.photos || []).filter((f) => f !== file);
  if (!item.photos.length) delete item.photos;
  deletePhotoFile(file);
  renderPhotos();
  renderTsList();
  scheduleSave();
}

function openLightbox(file) {
  $('lightbox-img').src = photoUrl(file);
  $('lightbox').hidden = false;
}
const closeLightbox = () => ($('lightbox').hidden = true);

function bindPhotos() {
  $('photo-input').onchange = (e) => {
    uploadPhotos(e.target.files);
    e.target.value = '';
  };
  const tile = $('photo-upload');
  tile.addEventListener('dragover', (e) => {
    e.preventDefault();
    tile.classList.add('dragover');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('dragover'));
  tile.addEventListener('drop', (e) => {
    e.preventDefault();
    tile.classList.remove('dragover');
    uploadPhotos(e.dataTransfer.files);
  });
  // A photo dropped anywhere else shouldn't navigate the tab to the file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('lightbox').onclick = closeLightbox;
}

function selectChild(c) {
  state.selectedChild = c;
  renderSelected();
  render();
}

function poisChanged() {
  syncDerived();
  renderPoiList();
  renderSelected();
  renderMapList();
  renderDisplay();
  renderDistance();
  render();
  scheduleSave();
}

function deleteSelected() {
  if (state.selectedChild) return deleteChild(state.selectedPoi, state.selectedChild);
  const m = mapData();
  const gone = state.selectedPoi;
  if (!gone) return;
  m.pois = m.pois.filter((p) => p !== gone);
  m.distanceRefs = m.distanceRefs.filter((r) => r.a !== gone.id && r.b !== gone.id);
  if (state.measure.a === gone || state.measure.b === gone) state.measure = { a: null, b: null };
  state.hoverPoi = null;
  selectPoi(null);
  poisChanged();
}

function deleteChild(parent, c) {
  parent.children = children(parent).filter((k) => k !== c);
  if (state.selectedChild === c) state.selectedChild = null;
  state.hoverPoi = null;
  poisChanged();
}

function normalizeAngle(deg) {
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  return Math.round(a * 10) / 10;
}

function setRotation(deg) {
  const m = mapData();
  if (m.northLocked || !state.img) return;
  m.rotation = normalizeAngle(deg);
  syncDerived();
  syncControls();
  render();
  scheduleSave();
}

function bindControls() {
  $('rot-slider').oninput = (e) => setRotation(Number(e.target.value));
  $('rot-input').onchange = (e) => setRotation(Number(e.target.value) || 0);
  for (const b of document.querySelectorAll('[data-rot]')) {
    b.onclick = () => setRotation(mapData().rotation + Number(b.dataset.rot));
  }

  $('lock-btn').onclick = () => {
    if (!state.img) return;
    const m = mapData();
    m.northLocked = !m.northLocked;
    syncControls();
    renderMapList();
    scheduleSave();
  };

  $('grid-toggle').onchange = (e) => {
    state.showGrid = e.target.checked;
    render();
  };
  $('grid-spacing').onchange = (e) => {
    mapData().gridSpacing = e.target.value;
    render();
    scheduleSave();
  };

  const moveSelectedTo = () => {
    const item = activeItem();
    if (!item) return;
    const gx = Number($('sel-x').value);
    const gy = Number($('sel-y').value);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    const ip = gridToImage(geometry(), gx, gy);
    moveItem(item, item === state.selectedChild, ip.u, ip.v);
    poisChanged();
  };
  $('sel-x').onchange = moveSelectedTo;
  $('sel-y').onchange = moveSelectedTo;
  $('sel-label').oninput = (e) => {
    const item = activeItem();
    if (!item) return;
    item.label = e.target.value.trim() || undefined;
    renderPoiList();
    renderSelected();
    render();
    scheduleSave();
  };
  $('sel-text').oninput = (e) => {
    const c = state.selectedChild;
    if (!c) return;
    c.text = e.target.value.trim() ? e.target.value : undefined;
    render();
    scheduleSave();
  };
  $('sel-delete').onclick = deleteSelected;
  $('fit-btn').onclick = fitView;

  $('zones-toggle').onchange = (e) => setZonesVisible(e.target.checked);

  $('icon-size').oninput = (e) => {
    settings().iconSize = Number(e.target.value);
    $('icon-size-val').textContent = e.target.value + 'px';
    render();
    scheduleSave();
  };

  $('m-save').onclick = saveKnownDistance;
  $('m-known').onkeydown = (e) => {
    if (e.key === 'Enter') saveKnownDistance();
  };

  bindPhotos();
  window.addEventListener('resize', render);
  new ResizeObserver(render).observe(canvas);
  window.addEventListener('keydown', onKey);
  bindCanvas();
}

function onKey(e) {
  if (e.target.matches('input, select, textarea')) return;
  if (!$('lightbox').hidden) {
    if (e.key === 'Escape') closeLightbox();
    return;
  }
  if (e.key === 'Escape' || e.key === 'v' || e.key === 'V') {
    if (e.key === 'Escape' && state.tool === 'measure' && state.measure.a) {
      measureClick(null); // first Esc clears the measurement, second leaves the tool
      return;
    }
    // Esc steps back one level: secondary tool → secondary icon → POI → nothing.
    if (e.key === 'Escape' && state.tool.startsWith(CHILD_TOOL_PREFIX)) return setTool('select');
    if (e.key === 'Escape' && state.selectedChild) return selectChild(null);
    setTool('select');
    if (e.key === 'Escape') selectPoi(null);
  } else if (e.key === 'm' || e.key === 'M') {
    setTool(state.tool === 'measure' ? 'select' : 'measure');
  } else if (e.key === 'f' || e.key === 'F') {
    fitView();
  } else if ((e.key === 'z' || e.key === 'Z') && !$('zones-toggle').disabled) {
    setZonesVisible(settings().showZones === false);
  } else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !$('vod-toggle').closest('section').hidden) {
    toggleVodPanel(!!$('vod-panel').hidden);
  } else if (state.readOnly) {
    return;
  } else if (/^[1-9]$/.test(e.key) && state.poiTypes[e.key - 1]) {
    setTool(state.poiTypes[e.key - 1].id);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
    e.preventDefault();
  }
}

// ------------------------------ canvas input ------------------------------

// Returns { poi, child } for whatever is under the cursor. Secondary icons of
// the selected POI are drawn on top, so they're tested first.
function hitTest(sx, sy) {
  if (!state.img) return null;
  const g = geometry();
  const r = settings().iconSize / 2;
  const inside = (item, radius) => {
    const s = poiScreenPos(g, item);
    return (s.x - sx) ** 2 + (s.y - sy) ** 2 <= radius * radius;
  };

  const parent = state.selectedPoi;
  if (parent && isVisible(parent)) {
    const kids = children(parent);
    for (let i = kids.length - 1; i >= 0; i--) {
      if (inside(kids[i], r * CHILD_SCALE)) return { poi: parent, child: kids[i] };
    }
  }
  const pois = visiblePois();
  for (let i = pois.length - 1; i >= 0; i--) {
    if (inside(pois[i], r)) return { poi: pois[i], child: null };
  }
  return null;
}

function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function bindCanvas() {
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.img) return;
    const pos = eventPos(e);
    const hit = e.button === 0 ? hitTest(pos.x, pos.y) : null;
    const measuring = state.tool === 'measure';
    canvas.setPointerCapture(e.pointerId);
    state.drag = {
      start: pos,
      last: pos,
      moved: false,
      // What a drag moves. Nothing is draggable while measuring or read-only.
      item: measuring || state.readOnly ? null : hit && (hit.child || hit.poi),
      isChild: !!hit?.child,
      clicked: hit?.poi ?? null,
      button: e.button,
    };
    if (hit && !measuring) {
      if (hit.child) selectChild(hit.child);
      else if (hit.poi !== state.selectedPoi || state.selectedChild) selectPoi(hit.poi);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const pos = eventPos(e);
    state.cursor = pos;
    const d = state.drag;

    if (d) {
      if (Math.hypot(pos.x - d.start.x, pos.y - d.start.y) > 4) d.moved = true;
      if (d.item && d.moved) {
        const f = screenToFrame(pos.x, pos.y);
        const ip = frameToImage(geometry(), f.x, f.y);
        moveItem(d.item, d.isChild, ip.u, ip.v);
        syncDerived();
        renderSelected();
        renderDistance();
      } else if (!d.item && d.moved) {
        state.view.panX += pos.x - d.last.x;
        state.view.panY += pos.y - d.last.y;
        canvas.classList.add('panning');
      }
      d.last = pos;
      render();
    } else {
      const hit = hitTest(pos.x, pos.y);
      const hover = hit ? hit.child || hit.poi : null;
      if (hover !== state.hoverPoi) {
        state.hoverPoi = hover;
        canvas.classList.toggle('over-poi', !!hover);
        render();
      }
      // Keep the live A → cursor line following the mouse.
      if (state.tool === 'measure' && state.measure.a && !state.measure.b) render();
    }
    updateStatus();
  });

  canvas.addEventListener('pointerup', (e) => {
    const d = state.drag;
    state.drag = null;
    canvas.classList.remove('panning');
    if (!d) return;

    if (d.item && d.moved) {
      poisChanged();
    } else if (!d.moved && d.button === 0 && state.tool === 'measure') {
      measureClick(d.clicked);
    } else if (!d.item && !d.moved && d.button === 0) {
      if (state.tool.startsWith(CHILD_TOOL_PREFIX)) placeChild(eventPos(e));
      else if (state.tool !== 'select') placePoi(eventPos(e));
      else if (!d.clicked) selectPoi(null); // read-only clicks on a POI land here
    }
  });

  canvas.addEventListener('pointerleave', () => {
    state.cursor = null;
    updateStatus();
    render();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pos = eventPos(e);
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const intensity = e.ctrlKey ? 0.01 : 0.0015;
    zoomAt(pos.x, pos.y, Math.exp(-e.deltaY * intensity));
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function placePoi(pos) {
  const ip = imagePosIfInside(pos);
  if (!ip) return;
  const poi = { id: newId(), type: state.tool, imagePos: ip };
  mapData().pois.push(poi);
  selectPoi(poi);
  vodLinkPlaced(poi, null);
  poisChanged();
}

function placeChild(pos) {
  const parent = state.selectedPoi;
  const ip = imagePosIfInside(pos);
  if (!parent || !ip) return;
  const child = { id: newId(), type: state.tool.slice(CHILD_TOOL_PREFIX.length), imagePos: ip };
  children(parent).push(child);
  state.selectedChild = child;
  vodLinkPlaced(parent, child);
  poisChanged();
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Image-space position for a screen point, or null if it's outside the map grid.
function imagePosIfInside(pos) {
  const g = geometry();
  const f = screenToFrame(pos.x, pos.y);
  const gp = frameToGrid(g, f.x, f.y);
  if (gp.x < 0 || gp.y < 0 || gp.x > g.gridW || gp.y > g.gridH) return null;
  const ip = frameToImage(g, f.x, f.y);
  return { x: round1(ip.u), y: round1(ip.v) };
}

function updateStatus() {
  $('zoom-level').textContent = state.img ? `${Math.round(state.view.zoom * 100)}%` : '';
  const c = state.cursor;
  if (!c || !state.img) {
    $('cursor-pos').textContent = '—';
    return;
  }
  const g = geometry();
  const f = screenToFrame(c.x, c.y);
  const gp = frameToGrid(g, f.x, f.y);
  const inside = gp.x >= 0 && gp.y >= 0 && gp.x <= g.gridW && gp.y <= g.gridH;
  $('cursor-pos').textContent = inside ? `x ${Math.round(gp.x)}  y ${Math.round(gp.y)}` : 'outside map';
}

// ------------------------------ VOD review --------------------------------
// Videos in vod_review/ play in the side panel. While paused there's a draft
// timestamp ("MM:SS Description") that can be linked to a POI / secondary icon
// (existing, or placed new) and given screenshots of the current frame.
// Saved in state.data.vods[file] = { map, duration, timestamps: [{ id, t, text,
// link, photos }] }; the server mirrors each list into vod_review/<name>.txt,
// always starting with "00:00 Start". `link` is { map, poi, child? } (ids) and
// may point at an icon that has since been deleted.

const VOD_MIN_WIDTH = 320;
const vod = {
  files: [],        // [{ file, name, size, txt }] from api/vods
  file: null,       // loaded video
  draft: null,      // { t, text, link, photos, editing: the timestamp being edited, or null }
  linkNext: false,  // link the next icon placed on the map to the draft
};
const video = $('vod-video');

// "MM:SS", or "H:MM:SS" for videos an hour or longer (YouTube's format).
function fmtTime(t, duration = vodDuration()) {
  const s = Math.max(0, Math.floor(t || 0));
  const mmss = String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  return duration >= 3600 ? Math.floor(s / 3600) + ':' + mmss : mmss;
}

function vodEntry(file, create = false) {
  const vods = (state.data.vods ??= {});
  if (!vods[file] && create) vods[file] = { map: state.currentId, timestamps: [] };
  return vods[file];
}

// Timestamps from an existing .txt ("MM:SS text" / "H:MM:SS text"), minus the Start line.
function parseTimestampTxt(txt) {
  const out = [];
  for (const line of txt.split('\n')) {
    const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const t = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (t === 0 && m[4] === 'Start') continue;
    out.push({ id: newId(), t, text: m[4] });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Timestamps (all VODs) linked to a secondary icon, or to a POI and its secondary icons.
function linkedTimestamps(poi, child) {
  const out = [];
  for (const [file, v] of Object.entries(state.data.vods || {})) {
    for (const ts of v.timestamps || []) {
      const l = ts.link;
      if (l && l.map === state.currentId && l.poi === poi.id && (!child || l.child === child.id)) out.push({ file, ts });
    }
  }
  return out;
}

// The video id from a youtu.be / youtube.com (watch, live, shorts, embed) URL.
function youtubeId(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    return u.searchParams.get('v') || /^\/(?:live|shorts|embed)\/([\w-]+)/.exec(u.pathname)?.[1] || null;
  } catch {
    return null;
  }
}

// Link to the VOD's YouTube upload at `t` seconds, or null if it has none.
function youtubeUrl(file, t = 0) {
  const ytId = youtubeId(vodEntry(file)?.youtube || '');
  return ytId && `https://youtu.be/${ytId}` + (t >= 1 ? `?t=${Math.floor(t)}` : '');
}

function youtubeLink(file, t, text) {
  const a = document.createElement('a');
  a.className = 'yt';
  a.href = youtubeUrl(file, t);
  a.target = '_blank';
  a.rel = 'noopener';
  a.innerHTML = '<img src="icons/youtube.png" alt="YouTube" />';
  a.title = `Open on YouTube at ${fmtTime(t, vodEntry(file)?.duration)}` + (text ? ` — ${text}` : '');
  a.onclick = (e) => e.stopPropagation();
  return a;
}

const linkOf = (poi, child) => ({ map: state.currentId, poi: poi.id, ...(child && { child: child.id }) });

function resolveLink(link) {
  const poi = state.data.maps[link.map]?.pois?.find((p) => p.id === link.poi);
  if (!poi) return null;
  const child = link.child ? children(poi).find((c) => c.id === link.child) : null;
  return link.child && !child ? null : { poi, child };
}

function linkInfo(link) {
  const r = resolveLink(link);
  if (!r) return { text: 'deleted icon', src: '' };
  const type = r.child ? secondaryType(r.child.type) : state.poiTypes.find((t) => t.id === r.poi.type);
  if (link.map !== state.currentId) {
    const mapName = state.maps.find((m) => m.id === link.map)?.name || link.map;
    return { text: `${(r.child || r.poi).label || type?.label} · ${mapName}`, src: type?.src };
  }
  const text = r.child ? `${childName(r.poi, r.child)} · ${poiName(r.poi)}` : poiName(r.poi);
  return { text, src: type?.src };
}

function linkChip(link) {
  const chip = document.createElement('span');
  chip.className = 'link-chip';
  const { text, src } = linkInfo(link);
  chip.innerHTML = '<img alt="" /><span></span>';
  if (src) chip.querySelector('img').src = src;
  else chip.querySelector('img').remove();
  chip.querySelector('span').textContent = text;
  chip.title = 'Show on map';
  chip.onclick = (e) => {
    e.stopPropagation();
    goToLink(link);
  };
  return chip;
}

async function goToLink(link) {
  if (!state.maps.some((m) => m.id === link.map)) return;
  if (link.map !== state.currentId) await selectMap(link.map);
  const r = resolveLink(link);
  if (!r || !state.img) return;
  if (!isVisible(r.poi)) setTypeVisible(r.poi.type, true);
  selectPoi(r.poi, true);
  if (r.child) selectChild(r.child);
}

// ------- panel / loading

async function toggleVodPanel(open) {
  $('vod-panel').hidden = !open;
  $('vod-toggle').innerHTML = (open ? '🎬 Close VOD review' : '🎬 Open VOD review') + ' <kbd>R</kbd>';
  localStorage.setItem('vodOpen', open ? '1' : '');
  if (!open) return vodPause();
  renderVod();
  if (!vod.files.length) await refreshVods();
}

async function refreshVods() {
  // The hosted site has no videos, just the reviewed VODs in map-data.json.
  if (state.readOnly) {
    vod.files = Object.entries(state.data.vods || {})
      .filter(([, v]) => v.timestamps?.length)
      .map(([file]) => ({ file, name: file.replace(/\.[^.]+$/, '') }))
      .sort((a, b) => b.file.localeCompare(a.file));
  } else try {
    const res = await fetch('api/vods');
    if (!res.ok) throw new Error(res.statusText);
    vod.files = await res.json();
  } catch (e) {
    setSaveState('Could not list VODs: ' + e.message, true);
  }
  const sel = $('vod-select');
  sel.innerHTML = '<option value="">— choose a video —</option>';
  for (const f of vod.files) {
    const o = document.createElement('option');
    o.value = f.file;
    o.textContent = f.name + (vodEntry(f.file)?.timestamps?.length ? ` (${vodEntry(f.file).timestamps.length})` : '');
    sel.appendChild(o);
  }
  sel.value = vod.file || '';
  const last = localStorage.getItem('lastVod');
  if (!vod.file && vod.files.some((f) => f.file === last)) loadVod(last);
}

// Ask before throwing away a draft that has something in it.
function draftDirty(d = vod.draft) {
  if (!d) return false;
  if (!d.editing) return !!(d.text.trim() || d.link || d.photos.length);
  const e = d.editing;
  return d.text !== e.text || d.t !== e.t || JSON.stringify(d.link) !== JSON.stringify(e.link ?? null)
    || d.photos.join() !== (e.photos || []).join();
}
const okToDiscard = () => !draftDirty() || confirm('Discard the unsaved timestamp?');

function loadVod(file) {
  if (file === vod.file) return true;
  if (!okToDiscard()) {
    $('vod-select').value = vod.file || '';
    return false;
  }
  discardDraft();
  vod.file = file || null;
  localStorage.setItem('lastVod', file || '');
  $('vod-select').value = file || '';
  if (state.readOnly) ytLoad(file);
  else {
    video.removeAttribute('src');
    if (file) video.src = 'vods/' + encodeURIComponent(file);
    video.load();
  }

  if (file) {
    // The VOD's map: the one it was reviewed on, else a map named in the file name.
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const guess = [...state.maps].sort((a, b) => b.name.length - a.name.length).find((m) => norm(file).includes(norm(m.name)));
    const mapId = state.maps.find((m) => m.id === vodEntry(file)?.map)?.id || guess?.id || state.currentId;

    // First open of a video with a hand-written .txt: import it.
    const txt = vod.files.find((f) => f.file === file)?.txt;
    const imported = !vodEntry(file) && txt ? parseTimestampTxt(txt) : [];
    if (imported.length) {
      state.data.vods[file] = { map: mapId, timestamps: imported };
      scheduleSave();
    }
    if (mapId !== state.currentId) selectMap(mapId);
  }
  renderVod();
  return true;
}

function vodMapChanged(id) {
  if (state.readOnly) return;
  const entry = vod.file && vodEntry(vod.file);
  if (entry && entry.map !== id) {
    entry.map = id;
    scheduleSave();
  }
}

// ------- playback
// Locally the <video> plays the file from vod_review/. The read-only site plays
// the VOD's YouTube upload in an embedded player (IFrame API) instead.

const ytEmbed = { player: null, ready: false, id: null, pending: null }; // pending: seek before the player is ready

let ytApi = null;
const loadYtApi = () =>
  (ytApi ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }));

async function ytLoad(file) {
  const id = file ? youtubeId(vodEntry(file)?.youtube || '') : null;
  $('vod-yt-wrap').hidden = !id;
  if (!id) {
    ytEmbed.id = null;
    if (ytEmbed.ready) ytEmbed.player.stopVideo();
    return renderVodTime();
  }
  if (id === ytEmbed.id) return;
  ytEmbed.id = id;
  if (ytEmbed.player) {
    if (ytEmbed.ready) ytEmbed.player.cueVideoById(id);
    return;
  }
  const YT = await loadYtApi();
  ytEmbed.player = new YT.Player('vod-yt', {
    videoId: id,
    playerVars: { rel: 0, playsinline: 1 },
    events: {
      onReady: () => {
        ytEmbed.ready = true;
        if (ytEmbed.player.getVideoData().video_id !== ytEmbed.id) ytEmbed.player.cueVideoById(ytEmbed.id); // switched while loading
        if (ytEmbed.pending != null) ytEmbed.player.seekTo(ytEmbed.pending, true);
        ytEmbed.pending = null;
        renderVodTime();
      },
      onStateChange: renderVodTime,
    },
  });
}

const vodTime = () => (state.readOnly ? (ytEmbed.ready ? ytEmbed.player.getCurrentTime() : ytEmbed.pending ?? 0) : video.currentTime);
const vodDuration = () => (state.readOnly ? (ytEmbed.ready && ytEmbed.player.getDuration()) || vodEntry(vod.file)?.duration : video.duration);
// YouTube states 1 = playing, 3 = buffering.
const vodPaused = () => (state.readOnly ? !(ytEmbed.ready && [1, 3].includes(ytEmbed.player.getPlayerState())) : video.paused);
const vodPlay = () => (state.readOnly ? ytEmbed.ready && ytEmbed.player.playVideo() : video.play().catch(() => {}));
const vodPause = () => (state.readOnly ? ytEmbed.ready && ytEmbed.player.pauseVideo() : video.pause());

const seekTo = (t) => {
  if (state.readOnly) {
    if (ytEmbed.ready) ytEmbed.player.seekTo(Math.max(t, 0), true);
    else ytEmbed.pending = t;
  } else if (video.readyState === 0) video.addEventListener('loadedmetadata', () => seekTo(t), { once: true });
  else video.currentTime = Math.min(Math.max(t, 0), video.duration || t);
};
const seekBy = (dt) => seekTo(vodTime() + dt);
const togglePlay = () => (vodPaused() ? vodPlay() : vodPause());

// Space / ←→ / ⌃⌘←→ / Enter / S. Capture phase so the native <video> controls
// don't also handle the arrows.
function onVodKey(e) {
  if ($('vod-panel').hidden || !vod.file || !$('lightbox').hidden) return;
  if (e.target.matches('input, select, textarea')) return;
  const mod = e.metaKey || e.ctrlKey || e.altKey;
  if ((e.key === ' ' || e.key === 'k') && !mod) togglePlay();
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey) {
    // 3 s: ⌃⌘ (Mac) or Shift (anywhere; Ctrl+Win+arrow switches desktops on Windows).
    const plain = !e.ctrlKey && !e.metaKey;
    const step = (e.ctrlKey && e.metaKey && !e.shiftKey) || (e.shiftKey && plain) ? 3 : plain ? 10 : 0;
    if (!step) return; // leave other combos (e.g. ⌘← = back) to the browser
    seekBy(e.key === 'ArrowLeft' ? -step : step);
  } else if (state.readOnly) {
    return;
  } else if (e.key === 'Enter' && !mod && video.paused) {
    ensureDraft();
    $('draft-text').focus();
  } else if ((e.key === 's' || e.key === 'S') && !mod) takeScreenshot();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

// ------- draft

function ensureDraft() {
  if (vod.draft || !vod.file || !video.paused || video.readyState === 0) return renderDraft();
  vod.draft = { t: video.currentTime, text: '', link: null, photos: [], editing: null };
  renderDraft();
}

function discardDraft() {
  const d = vod.draft;
  if (!d) return;
  const keep = new Set(d.editing?.photos || []);
  for (const f of d.photos) if (!keep.has(f)) deletePhotoFile(f);
  vod.draft = null;
  stopLinkNext();
}

function stopLinkNext() {
  if (!vod.linkNext) return;
  vod.linkNext = false;
  setTool('select');
}

function editTimestamp(ts) {
  if (state.readOnly) {
    // Hosted site: nothing to edit, just play from here and show the icon.
    seekTo(ts.t);
    vodPlay();
    if (ts.link) goToLink(ts.link);
    return;
  }
  if (vod.draft?.editing === ts) return seekTo(ts.t);
  if (!okToDiscard()) return;
  discardDraft();
  video.pause();
  seekTo(ts.t);
  vod.draft = { t: ts.t, text: ts.text, link: ts.link ?? null, photos: [...(ts.photos || [])], editing: ts };
  renderVod();
  if (ts.link) goToLink(ts.link);
}

async function playTimestamp(file, ts) {
  await toggleVodPanel(true);
  if (!vod.files.some((f) => f.file === file)) await refreshVods();
  if (!vod.files.some((f) => f.file === file)) return setSaveState('Video not in vod_review/: ' + file, true);
  if (loadVod(file)) editTimestamp(ts);
}

function saveDraft() {
  const d = vod.draft;
  const text = d?.text.trim();
  if (!text) return $('draft-text').focus();
  const entry = vodEntry(vod.file, true);
  entry.map = state.currentId;
  if (video.duration) entry.duration = round1(video.duration);
  const ts = d.editing || { id: newId() };
  for (const f of ts.photos || []) if (!d.photos.includes(f)) deletePhotoFile(f);
  Object.assign(ts, { t: round1(d.t), text, link: d.link || undefined, photos: d.photos.length ? d.photos : undefined });
  if (!d.editing) entry.timestamps.push(ts);
  entry.timestamps.sort((a, b) => a.t - b.t);
  vod.draft = null;
  stopLinkNext();
  $('draft-text').blur();
  ensureDraft();
  renderVod();
  renderSelected();
  scheduleSave();
}

function deleteTimestamp(ts) {
  const entry = vodEntry(vod.file);
  if (vod.draft?.editing === ts) discardDraft();
  for (const f of ts.photos || []) deletePhotoFile(f);
  entry.timestamps = entry.timestamps.filter((x) => x !== ts);
  ensureDraft();
  renderVod();
  renderSelected();
  scheduleSave();
}

// A "New" icon button was used and the icon has just been placed.
function vodLinkPlaced(poi, child) {
  if (!vod.linkNext || !vod.draft) return;
  vod.draft.link = linkOf(poi, child);
  stopLinkNext();
  renderDraft();
}

async function takeScreenshot() {
  if (!vod.file || !video.videoWidth) return;
  if (!video.paused) video.pause();
  if (!vod.draft) vod.draft = { t: video.currentTime, text: '', link: null, photos: [], editing: null };
  const d = vod.draft;
  const btn = $('draft-shot');
  btn.disabled = true;
  try {
    setSaveState('Saving screenshot…');
    const file = await uploadPhoto(await resizePhoto(video));
    if (vod.draft === d) d.photos.push(file);
    else deletePhotoFile(file); // the draft was saved / discarded meanwhile
    setSaveState('Screenshot added');
  } catch (e) {
    setSaveState('Screenshot failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
    renderDraft();
  }
}

// ------- rendering

function renderVod() {
  $('vod-select').value = vod.file || '';
  const ytInput = $('vod-youtube');
  ytInput.disabled = !vod.file;
  if (document.activeElement !== ytInput) ytInput.value = (vod.file && vodEntry(vod.file)?.youtube) || '';
  ytInput.classList.toggle('invalid', !!ytInput.value.trim() && !youtubeId(ytInput.value));
  const yt = vod.file && youtubeUrl(vod.file);
  $('vod-youtube-open').hidden = !yt;
  if (yt) $('vod-youtube-open').href = yt;
  $('vod-file-hint').textContent = state.readOnly
    ? vod.file && !yt ? 'No YouTube link for this VOD.' : vod.files.length ? '' : 'No reviewed VODs yet.'
    : vod.file ? `Saved to vod_review/${vod.file.replace(/\.[^.]+$/, '')}.txt`
    : vod.files.length ? '' : 'No videos in vod_review/.';
  renderVodTime();
  renderTsList();
  renderDraft();
}

function renderVodTime() {
  $('vod-play').textContent = vodPaused() ? '▶' : '❚❚';
  const loaded = vod.file && (state.readOnly ? ytEmbed.ready && ytEmbed.id : video.readyState);
  $('vod-time').textContent = loaded ? `${fmtTime(vodTime())} / ${fmtTime(vodDuration())}` : '';
  if (vod.draft) $('draft-time').textContent = fmtTime(vod.draft.t);
  markCurrentTs();
}

function renderTsList() {
  const list = $('ts-list');
  list.innerHTML = '';
  const items = (vod.file && vodEntry(vod.file)?.timestamps) || [];
  $('ts-count').textContent = items.length;
  if (!vod.file) return;
  const row = (t, text, ts) => {
    const li = document.createElement('li');
    li.dataset.t = t;
    li.classList.toggle('selected', !!ts && vod.draft?.editing === ts);
    li.innerHTML = '<span class="ts"></span><span class="name"></span>';
    li.querySelector('.ts').textContent = fmtTime(t);
    li.querySelector('.name').textContent = text;
    if (youtubeUrl(vod.file)) li.prepend(youtubeLink(vod.file, t));
    if (ts) {
      li.title = 'Edit (and show its icon on the map)';
      if (ts.link) li.appendChild(linkChip(ts.link));
      if (ts.photos?.length) {
        const n = document.createElement('span');
        n.className = 'val';
        n.textContent = '📷' + ts.photos.length;
        li.appendChild(n);
      }
      const del = document.createElement('button');
      del.title = 'Delete timestamp';
      del.textContent = '×';
      del.onclick = (e) => {
        e.stopPropagation();
        deleteTimestamp(ts);
      };
      li.appendChild(del);
    }
    li.onclick = () => (ts ? editTimestamp(ts) : seekTo(0));
    list.appendChild(li);
  };
  row(0, 'Start', null);
  for (const ts of items) row(ts.t, ts.text, ts);
  markCurrentTs();
}

// Highlight the timestamp the playhead is in, without rebuilding the list.
function markCurrentTs() {
  const now = vodTime() + 0.25;
  const lis = [...$('ts-list').children];
  const current = lis.findLast((li) => Number(li.dataset.t) <= now);
  for (const li of lis) li.classList.toggle('current', li === current);
}

function renderDraft() {
  const d = vod.draft;
  $('vod-draft').hidden = !d || $('vod-panel').hidden;
  if (!d) return;
  $('draft-time').textContent = fmtTime(d.t);
  if (document.activeElement !== $('draft-text')) $('draft-text').value = d.text;
  $('draft-save').textContent = d.editing ? 'Save changes' : 'Add timestamp';
  $('draft-save').disabled = !d.text.trim();
  $('draft-retime').hidden = !d.editing;

  const chip = $('draft-link');
  chip.replaceChildren(d.link ? linkChip(d.link) : document.createTextNode('none'));
  $('draft-unlink').hidden = !d.link;
  const sel = state.selectedPoi;
  const selBtn = $('draft-link-selected');
  selBtn.disabled = !sel;
  selBtn.title = sel ? 'Link ' + (state.selectedChild ? childName(sel, state.selectedChild) : poiName(sel))
    : 'Select an icon on the map first';

  for (const b of $('draft-new').children) {
    const isChild = b.dataset.tool.startsWith(CHILD_TOOL_PREFIX);
    b.disabled = isChild && !sel;
    b.classList.toggle('active', vod.linkNext && state.tool === b.dataset.tool);
  }

  const photos = $('draft-photos');
  photos.innerHTML = '';
  for (const file of d.photos) {
    const tile = document.createElement('div');
    tile.className = 'draft-photo';
    tile.innerHTML = '<img alt="" /><button title="Remove">×</button>';
    tile.querySelector('img').src = photoUrl(file);
    tile.querySelector('img').onclick = () => openLightbox(file);
    tile.querySelector('button').onclick = () => {
      d.photos = d.photos.filter((f) => f !== file);
      if (!d.editing?.photos?.includes(file)) deletePhotoFile(file);
      renderDraft();
    };
    photos.appendChild(tile);
  }

  $('draft-hint').textContent = vod.linkNext
    ? 'Click the map to place the new icon — it will be linked to this timestamp.'
    : d.editing ? 'Editing a saved timestamp.' : '';
}

// ------- setup

function initVod() {
  const newIcons = $('draft-new');
  const addNewBtn = (t, tool, title) => {
    const b = document.createElement('button');
    b.className = 'new-icon';
    b.dataset.tool = tool;
    b.title = title;
    b.innerHTML = '<img alt="" />';
    b.querySelector('img').src = t.src;
    b.onclick = () => {
      if (vod.linkNext && state.tool === tool) return stopLinkNext();
      setTool(tool);
      vod.linkNext = state.tool === tool;
      renderDraft();
    };
    newIcons.appendChild(b);
  };
  for (const t of state.poiTypes) addNewBtn(t, t.id, `New ${t.label} — click the map to place it`);
  for (const t of state.secondaryTypes) {
    addNewBtn(t, CHILD_TOOL_PREFIX + t.id, `New ${t.label} on the selected POI — click the map to place it`);
  }

  $('vod-toggle').onclick = () => toggleVodPanel(!!$('vod-panel').hidden);
  $('vod-close').onclick = () => toggleVodPanel(false);
  $('vod-refresh').onclick = refreshVods;
  $('vod-select').onchange = (e) => loadVod(e.target.value);
  $('vod-youtube').oninput = (e) => {
    if (!vod.file) return;
    const url = e.target.value.trim();
    if (url) vodEntry(vod.file, true).youtube = url;
    else if (vodEntry(vod.file)) delete vodEntry(vod.file).youtube;
    renderVod();
    renderSelected();
    scheduleSave();
  };
  $('vod-play').onclick = togglePlay;
  for (const b of document.querySelectorAll('[data-seek]')) b.onclick = () => seekBy(Number(b.dataset.seek));

  video.addEventListener('loadedmetadata', () => {
    const entry = vodEntry(vod.file);
    if (entry && entry.duration !== round1(video.duration)) {
      entry.duration = round1(video.duration);
      scheduleSave();
    }
    ensureDraft();
    renderVod();
  });
  video.addEventListener('pause', () => {
    ensureDraft();
    renderVodTime();
  });
  video.addEventListener('play', () => {
    if (vod.draft && !draftDirty()) {
      discardDraft();
      renderVod();
    }
    renderVodTime();
  });
  video.addEventListener('timeupdate', () => {
    // A new draft's time follows the playhead while paused (seeking to the moment).
    const d = vod.draft;
    if (d && !d.editing && video.paused) d.t = video.currentTime;
    renderVodTime();
  });
  video.addEventListener('error', () => {
    if (vod.file) setSaveState('Could not play ' + vod.file, true);
  });
  window.addEventListener('keydown', onVodKey, true);

  $('draft-text').oninput = (e) => {
    vod.draft.text = e.target.value;
    $('draft-save').disabled = !e.target.value.trim();
  };
  $('draft-text').onkeydown = (e) => {
    if (e.key === 'Enter') saveDraft();
    else if (e.key === 'Escape') e.target.blur();
  };
  $('draft-time').onclick = () => seekTo(vod.draft.t);
  $('draft-save').onclick = saveDraft;
  $('draft-cancel').onclick = () => {
    discardDraft();
    ensureDraft();
    renderVod();
  };
  $('draft-retime').onclick = () => {
    vod.draft.t = video.currentTime;
    renderDraft();
  };
  $('draft-link-selected').onclick = () => {
    if (!state.selectedPoi) return;
    vod.draft.link = linkOf(state.selectedPoi, state.selectedChild);
    renderDraft();
  };
  $('draft-unlink').onclick = () => {
    vod.draft.link = null;
    renderDraft();
  };
  $('draft-shot').onclick = takeScreenshot;

  // Drag the panel's left edge to resize it.
  const panel = $('vod-panel');
  const setWidth = (w) => (panel.style.width = Math.max(VOD_MIN_WIDTH, Math.min(w, window.innerWidth - 400)) + 'px');
  if (localStorage.getItem('vodWidth')) setWidth(Number(localStorage.getItem('vodWidth')));
  $('vod-resizer').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      panel.classList.remove('resizing');
      localStorage.setItem('vodWidth', parseInt(panel.style.width, 10));
    };
    panel.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // Hosted site: only offer VOD review once there are reviewed VODs.
  if (state.readOnly) $('vod-toggle').closest('section').hidden = !Object.values(state.data.vods || {}).some((v) => v.timestamps?.length);
  if (state.readOnly) setInterval(() => !$('vod-panel').hidden && ytEmbed.ready && renderVodTime(), 500);
  if (localStorage.getItem('vodOpen') && !$('vod-toggle').closest('section').hidden) toggleVodPanel(true);
}

// --------------------------------- init -----------------------------------

async function init() {
  const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(url + ': ' + r.status))));
  // Local server first; the GitHub Pages build ships static files instead.
  const [config, data] = await Promise.all([getJson('api/config'), getJson('api/data')]).catch(() =>
    Promise.all([getJson('config.json'), getJson('map-data.json')]),
  );
  state.readOnly = !!config.readOnly;
  document.body.classList.toggle('readonly', state.readOnly);
  for (const el of document.querySelectorAll('#sel-x, #sel-y, #sel-label')) el.disabled = state.readOnly;
  $('sel-text').readOnly = state.readOnly; // still readable on the hosted site
  if (state.readOnly) setSaveState('Read-only');
  state.maps = config.maps;
  state.poiTypes = config.poiTypes;
  state.secondaryTypes = config.secondaryTypes || [];
  state.data = data;
  for (const t of [...state.poiTypes, ...state.secondaryTypes]) {
    const img = new Image();
    img.onload = render;
    img.src = t.src;
    state.poiIcons[t.id] = img;
  }

  renderTools();
  bindControls();
  initVod();

  const last = localStorage.getItem('lastMap');
  const first = state.maps.find((m) => m.id === last) ?? state.maps[0];
  if (first) selectMap(first.id);
  else renderMapList();
}

init().catch((e) => {
  $('loading').hidden = false;
  $('loading').textContent = 'Failed to start: ' + e.message + ' (is server.js running?)';
});
