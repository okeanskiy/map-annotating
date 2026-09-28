import {
  ID_PATTERN,
  bbox,
  centroid,
  mapExtent,
  polygonArea,
  polylineLength,
  polylineMidpoint,
  round,
} from './model.js';

const $ = (sel) => document.querySelector(sel);
const svg = $('#canvas');
const inspector = $('#inspector');
const clientId = Math.random().toString(36).slice(2);

const MIN_POINTS = { area: 3, line: 2 };
const TYPE_ICON = { area: '▱', line: '〰', point: '●' };
const DEFAULT_COLOR = '#64748b';
const SELECT_COLOR = '#0ea5e9';
const HINTS = {
  select:
    'Click to select · Drag to move · Drag handles to reshape (Shift: free image resize) · Click a midpoint dot to add a vertex · Alt+click a vertex to delete it · Drag empty space to pan · Paste or drop images onto the map',
  area: 'Click to add corners · Double-click, Enter or right-click to finish · Backspace removes the last corner · Esc cancels',
  line: 'Click to add points · Double-click, Enter or right-click to finish · Backspace removes the last point · Esc cancels',
  point: 'Click to place a point',
};

const state = {
  doc: null,
  rev: null,
  diskErrors: null,
  diskRev: null,
  selectedId: null,
  tool: 'select',
  drawCategory: '',
  draft: null,
  view: { x: 0, y: 0, scale: 1 },
  cursor: null,
  undo: [],
  redo: [],
  lastCheckpoint: { key: null, time: 0 },
  saveTimer: null,
  saving: false,
  saveAgain: false,
  previewTimer: null,
  imageDataUrls: new Map(),
  connectedOnce: false,
};

// ------------------------------------------------------------------ helpers

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function num(n) {
  return String(round(n, 3));
}

function coordDigits() {
  const d = state.doc ? Math.max(state.doc.bounds.width, state.doc.bounds.height) : 1000;
  return Math.max(0, 3 - Math.floor(Math.log10(d)));
}

function roundPt([x, y]) {
  const d = coordDigits();
  return [round(x, d), round(y, d)];
}

function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

function niceStep(target) {
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
  return 10 * p;
}

function getFeature(id) {
  return state.doc?.features.find((f) => f.id === id) ?? null;
}

function getImage(id) {
  return state.doc?.images?.find((img) => img.id === id) ?? null;
}

/** The selected feature, if the selection is a feature. */
function selected() {
  return getFeature(state.selectedId);
}

/** The selected image, if the selection is an image. */
function selectedImage() {
  return getImage(state.selectedId);
}

function idTaken(id) {
  return !!(getFeature(id) || getImage(id));
}

function featureColor(doc, f) {
  return f.color || doc.categories?.[f.category]?.color || DEFAULT_COLOR;
}

function nextId(prefix) {
  let n = 1;
  while (idTaken(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function readOnly() {
  return !state.doc || !!state.diskErrors;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
}

function setStatus(text, isError = false) {
  const el = $('#save-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------------------------------------------------------------- undo/redo

/** Snapshot the document before a change. Edits sharing a `key` within 1.5s collapse into one step. */
function checkpoint(key = null) {
  const now = Date.now();
  const last = state.lastCheckpoint;
  if (key && key === last.key && now - last.time < 1500) {
    last.time = now;
    return;
  }
  state.undo.push(JSON.stringify(state.doc));
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
  state.lastCheckpoint = { key, time: now };
}

function undo() {
  if (readOnly() || !state.undo.length) return;
  state.redo.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.undo.pop());
  state.lastCheckpoint = { key: null, time: 0 };
  changed({ inspector: true });
}

function redo() {
  if (readOnly() || !state.redo.length) return;
  state.undo.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.redo.pop());
  state.lastCheckpoint = { key: null, time: 0 };
  changed({ inspector: true });
}

/** Call after mutating state.doc. */
function changed({ inspector: rebuildInspector = false } = {}) {
  if (state.selectedId && !idTaken(state.selectedId)) state.selectedId = null;
  render();
  renderList();
  renderTitle();
  if (rebuildInspector) renderInspector();
  scheduleSave();
}

// ------------------------------------------------------------------- saving

function scheduleSave() {
  clearTimeout(state.saveTimer);
  setStatus('Unsaved changes…');
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    save();
  }, 300);
}

async function save({ force = false } = {}) {
  if (!state.doc || (state.diskErrors && !force)) return;
  if (state.saving) {
    state.saveAgain = true;
    return;
  }
  state.saving = true;
  setStatus('Saving…');
  try {
    const res = await fetch('/api/map', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
      body: JSON.stringify({ doc: state.doc, baseRev: force ? state.diskRev : state.rev }),
    });
    const data = await res.json();
    if (res.ok) {
      state.rev = data.rev;
      if (state.diskErrors) {
        state.diskErrors = null;
        renderBanner();
        renderInspector();
      }
      setStatus('Saved');
      schedulePreview();
    } else if (res.status === 409) {
      state.saveAgain = false;
      adopt(data, { external: true });
      if (!data.errors?.length) {
        toast(
          'map.json was changed outside the editor, so that version was loaded.\nPress Ctrl+Z to bring back your edit (this discards the outside change).',
        );
      }
    } else {
      setStatus('Not saved', true);
      toast(`Could not save: ${(data.errors || [data.error]).join('\n')}`, 'error');
    }
  } catch {
    setStatus('Offline — not saved', true);
  } finally {
    state.saving = false;
  }
  if (state.saveAgain) {
    state.saveAgain = false;
    save();
  }
}

/** Take a document state from the server (initial load, disk change, or conflict). */
function adopt(msg, { external = false } = {}) {
  if (msg.errors?.length) {
    state.diskErrors = msg.errors;
    state.diskRev = msg.rev;
    setStatus('map.json has errors', true);
    renderBanner();
    renderInspector();
    return;
  }
  const hadDoc = !!state.doc;
  if (external && hadDoc) checkpoint();
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  state.saveAgain = false;
  state.doc = msg.doc;
  state.rev = msg.rev;
  state.diskErrors = null;
  state.diskRev = msg.rev;
  if (state.selectedId && !idTaken(state.selectedId)) state.selectedId = null;
  if (!hadDoc) fitView();
  renderBanner();
  renderAll();
  setStatus('Saved');
  schedulePreview();
  if (external && hadDoc && !msg.silent) toast('Map updated from disk');
}

// ------------------------------------------------------------ preview.png

function schedulePreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(writePreview, 1200);
}

/** Images must be inlined as data URLs to be drawn into the preview canvas. */
async function imageDataUrl(file) {
  if (state.imageDataUrls.has(file)) return state.imageDataUrls.get(file);
  const res = await fetch(imageHref(file));
  if (!res.ok) return null;
  const blob = await res.blob();
  const url = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
  state.imageDataUrls.set(file, url);
  return url;
}

/** Renders the whole map (no UI chrome) to preview.png in the map folder, for agents to look at. */
async function writePreview() {
  const doc = state.doc;
  if (!doc || state.diskErrors) return;
  try {
    // Cover everything: the map frame, all images and all features.
    const e = mapExtent(doc);
    const pad = Math.max(e.maxX - e.minX, e.maxY - e.minY) * 0.02;
    const clip = { minX: e.minX - pad, minY: e.minY - pad, maxX: e.maxX + pad, maxY: e.maxY + pad };
    const W = clip.maxX - clip.minX;
    const H = clip.maxY - clip.minY;
    const k = 2048 / Math.max(W, H);
    const pw = Math.round(W * k);
    const ph = Math.round(H * k);
    const urls = new Map();
    for (const img of doc.images || []) urls.set(img.file, await imageDataUrl(img.file));
    const body = mapSvg(doc, 1.4 / k, { imageUrl: (file) => urls.get(file), interactive: false, clip });
    const text = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="${clip.minX} ${clip.minY} ${W} ${H}">${body}</svg>`;
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    canvas.getContext('2d').drawImage(img, 0, 0, pw, ph);
    URL.revokeObjectURL(url);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    await fetch('/api/preview', { method: 'POST', body: png });
  } catch (e) {
    console.warn('preview failed', e);
  }
}

// ---------------------------------------------------------------- rendering

function imageHref(file) {
  return `/project/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * SVG markup for the map in world coordinates, covering the `clip` rectangle.
 * `u` is the size of one screen pixel in world units, so strokes and labels
 * keep a constant on-screen size. Layer order: canvas, images, grid, map
 * frame, features, labels.
 */
function mapSvg(doc, u, { imageUrl = imageHref, interactive = true, clip }) {
  const { width: W, height: H } = doc.bounds;
  const cw = clip.maxX - clip.minX;
  const ch = clip.maxY - clip.minY;
  let out = `<rect x="${clip.minX}" y="${clip.minY}" width="${cw}" height="${ch}" fill="#ebe8e1" pointer-events="none"/>`;
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="#f7f5ef" pointer-events="none"/>`;
  for (const img of doc.images || []) out += imageSvg(img, imageUrl(img.file), interactive);
  out += gridSvg(u, clip);
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#475569" stroke-width="${1.5 * u}" pointer-events="none"/>`;
  for (const f of doc.features) out += featureSvg(doc, f, u, interactive);
  for (const f of doc.features) out += labelSvg(f, u, interactive);
  return out;
}

function imageSvg(img, href, interactive) {
  if (!href) return '';
  // Locked images ignore the pointer so clicks fall through to panning.
  const hit = interactive && !img.locked ? ` data-img="${esc(img.id)}"` : ' pointer-events="none"';
  return `<image href="${esc(href)}" x="${img.x}" y="${img.y}" width="${img.width}" height="${img.height}" preserveAspectRatio="none" opacity="${img.opacity ?? 1}"${hit}/>`;
}

/** An unbounded grid: lines and coordinate labels across the whole visible area. */
function gridSvg(u, clip) {
  const step = niceStep(90 * u);
  const x0 = Math.floor(clip.minX / step) * step;
  const y0 = Math.floor(clip.minY / step) * step;
  const major = [];
  const minor = [];
  let labels = '';
  const fs = 10 * u;
  const labelStyle = `font-size="${fs}" fill="#64748b" font-family="system-ui, sans-serif" stroke="#f7f5ef" stroke-width="${2.5 * u}" paint-order="stroke"`;
  const topY = clip.minY + fs * 1.2;
  const leftX = clip.minX + 3 * u;
  const isMajor = (v) => Math.abs(Math.round(v / step) % 5) === 0;
  for (let i = 0, x = x0; x <= clip.maxX && i < 1000; i++, x = x0 + i * step) {
    (isMajor(x) ? major : minor).push(`M${x} ${clip.minY}V${clip.maxY}`);
    labels += `<text x="${x + 3 * u}" y="${topY}" ${labelStyle}>${num(x)}</text>`;
  }
  for (let i = 0, y = y0; y <= clip.maxY && i < 1000; i++, y = y0 + i * step) {
    (isMajor(y) ? major : minor).push(`M${clip.minX} ${y}H${clip.maxX}`);
    if (y > clip.minY + fs * 2) labels += `<text x="${leftX}" y="${y - 3 * u}" ${labelStyle}>${num(y)}</text>`;
  }
  return (
    `<g pointer-events="none">` +
    `<path d="${minor.join('')}" fill="none" stroke="#94a3b8" stroke-opacity="0.3" stroke-width="${u}"/>` +
    `<path d="${major.join('')}" fill="none" stroke="#64748b" stroke-opacity="0.4" stroke-width="${u}"/>` +
    `${labels}</g>`
  );
}

function arrowsSvg(points, color, u) {
  const spacing = 90 * u;
  const size = 6 * u;
  let out = '';
  let next = spacing / 2;
  let acc = 0;
  let count = 0;
  for (let i = 1; i < points.length && count < 400; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    const seg = Math.hypot(x2 - x1, y2 - y1);
    if (seg === 0) continue;
    const dx = (x2 - x1) / seg;
    const dy = (y2 - y1) / seg;
    while (next <= acc + seg && count < 400) {
      const t = next - acc;
      const cx = x1 + dx * t;
      const cy = y1 + dy * t;
      const tip = [cx + dx * size, cy + dy * size];
      const l = [cx - dx * size + -dy * size * 0.8, cy - dy * size + dx * size * 0.8];
      const r = [cx - dx * size - -dy * size * 0.8, cy - dy * size - dx * size * 0.8];
      out += `<polygon points="${tip} ${l} ${r}" fill="${color}" stroke="#fff" stroke-width="${u}" pointer-events="none"/>`;
      next += spacing;
      count++;
    }
    acc += seg;
  }
  return out;
}

function featureSvg(doc, f, u, interactive) {
  const c = featureColor(doc, f);
  const data = interactive ? ` data-fid="${esc(f.id)}"` : '';
  const pts = f.points.map((p) => p.join(',')).join(' ');
  if (f.type === 'area') {
    return `<polygon points="${pts}" fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="${2 * u}" stroke-linejoin="round"${data}/>`;
  }
  if (f.type === 'line') {
    let out = '';
    if (f.width) {
      out += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-opacity="0.3" stroke-width="${f.width}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`;
    }
    out += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="${2.5 * u}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`;
    if (f.directed) out += arrowsSvg(f.points, c, u);
    if (interactive) {
      out += `<polyline points="${pts}" fill="none" stroke="transparent" stroke-width="${Math.max(12 * u, f.width || 0)}" stroke-linecap="round" stroke-linejoin="round"${data}/>`;
    }
    return out;
  }
  const [x, y] = f.points[0];
  return `<circle cx="${x}" cy="${y}" r="${6 * u}" fill="${c}" stroke="#fff" stroke-width="${2 * u}"${data}/>`;
}

function labelSvg(f, u, interactive) {
  // The preview image always shows ids so agents can cross-reference map.json.
  const text = interactive ? f.name || f.id : f.name ? `${f.name} [${f.id}]` : f.id;
  let x, y;
  let anchor = 'middle';
  if (f.type === 'area') [x, y] = centroid(f.points);
  else if (f.type === 'line') {
    [x, y] = polylineMidpoint(f.points);
    y -= 8 * u;
  } else {
    [x, y] = f.points[0];
    x += 9 * u;
    y += 4 * u;
    anchor = 'start';
  }
  return `<text x="${x}" y="${y}" font-size="${12 * u}" font-family="system-ui, sans-serif" font-weight="600" text-anchor="${anchor}" fill="#1e293b" stroke="#fff" stroke-width="${3 * u}" stroke-linejoin="round" paint-order="stroke" pointer-events="none">${esc(text)}</text>`;
}

function imageSelectionSvg(img, u) {
  const c = SELECT_COLOR;
  const { x, y, width: w, height: h } = img;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="${2 * u}" stroke-dasharray="${6 * u} ${4 * u}" pointer-events="none"/>`;
  if (img.locked) return out;
  const r = 5 * u;
  [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ].forEach(([cx, cy], i) => {
    out += `<rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" fill="#fff" stroke="${c}" stroke-width="${2 * u}" data-corner="${i}"/>`;
  });
  return out;
}

function selectionSvg(u) {
  const img = selectedImage();
  if (img) return imageSelectionSvg(img, u);
  const f = selected();
  if (!f) return '';
  const c = SELECT_COLOR;
  const pts = f.points.map((p) => p.join(',')).join(' ');
  let out = '';
  if (f.type === 'area')
    out += `<polygon points="${pts}" fill="none" stroke="${c}" stroke-width="${2 * u}" stroke-dasharray="${6 * u} ${4 * u}" pointer-events="none"/>`;
  if (f.type === 'line')
    out += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="${2 * u}" stroke-dasharray="${6 * u} ${4 * u}" pointer-events="none"/>`;
  if (f.type === 'point') {
    const [x, y] = f.points[0];
    out += `<circle cx="${x}" cy="${y}" r="${11 * u}" fill="none" stroke="${c}" stroke-width="${2 * u}" pointer-events="none"/>`;
  }
  if (f.type !== 'point') {
    const n = f.points.length;
    const edges = f.type === 'area' ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const [x1, y1] = f.points[i];
      const [x2, y2] = f.points[(i + 1) % n];
      out += `<circle cx="${(x1 + x2) / 2}" cy="${(y1 + y2) / 2}" r="${3.5 * u}" fill="${c}" fill-opacity="0.75" data-mid="${i}"/>`;
    }
  }
  f.points.forEach(([x, y], i) => {
    out += `<circle cx="${x}" cy="${y}" r="${5 * u}" fill="#fff" stroke="${c}" stroke-width="${2 * u}" data-vertex="${i}"/>`;
  });
  return out;
}

function draftSvg(u) {
  const d = state.draft;
  if (!d) return '';
  const c = state.doc.categories?.[state.drawCategory]?.color || SELECT_COLOR;
  const pts = state.cursor ? [...d.points, state.cursor] : d.points;
  const s = pts.map((p) => p.join(',')).join(' ');
  let out = '';
  if (d.type === 'area' && pts.length >= 3)
    out += `<polygon points="${s}" fill="${c}" fill-opacity="0.15" stroke="none" pointer-events="none"/>`;
  out += `<polyline points="${s}" fill="none" stroke="${c}" stroke-width="${2 * u}" stroke-dasharray="${5 * u} ${4 * u}" pointer-events="none"/>`;
  for (const [x, y] of d.points) {
    out += `<circle cx="${x}" cy="${y}" r="${4 * u}" fill="#fff" stroke="${c}" stroke-width="${2 * u}" pointer-events="none"/>`;
  }
  return out;
}

function render() {
  const w = svg.clientWidth;
  const h = svg.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (!state.doc) {
    svg.innerHTML = '';
    return;
  }
  const { x, y, scale: s } = state.view;
  const u = 1 / s;
  const clip = { minX: x, minY: y, maxX: x + w * u, maxY: y + h * u };
  svg.innerHTML =
    `<g transform="translate(${-x * s} ${-y * s}) scale(${s})">` +
    mapSvg(state.doc, u, { interactive: true, clip }) +
    selectionSvg(u) +
    draftSvg(u) +
    '</g>';
  $('#zoom-level').textContent = `${Math.round(s * 100)}%`;
}

function renderTitle() {
  const name = state.doc?.name || 'Map Annotator';
  $('#map-title').textContent = name;
  document.title = `${name} — Map Annotator`;
}

function renderList() {
  const list = $('#feature-list');
  const doc = state.doc;
  const images = doc?.images || [];
  $('#feature-count').textContent = doc ? `(${doc.features.length + images.length})` : '';
  if (!doc || !(doc.features.length + images.length)) {
    list.innerHTML = `<li class="empty">Nothing here yet. Pick a tool above and draw on the map, or paste/drop an image onto it.</li>`;
    return;
  }
  // Topmost first, like a layer list. Images always sit beneath all features.
  const imageRows = images
    .slice()
    .reverse()
    .map(
      (
        img,
      ) => `<li data-id="${esc(img.id)}" class="${img.id === state.selectedId ? 'selected' : ''}" title="${esc(img.file)}">
        <span class="swatch image-swatch"></span>
        <span class="icon">▣</span>
        <span class="name">${esc(img.name || img.id)}</span>
        <span class="fid">${img.locked ? '🔒 ' : ''}${img.name ? esc(img.id) : 'image'}</span>
      </li>`,
    )
    .join('');
  list.innerHTML =
    doc.features
      .slice()
      .reverse()
      .map(
        (
          f,
        ) => `<li data-id="${esc(f.id)}" class="${f.id === state.selectedId ? 'selected' : ''}" title="${esc(f.notes || '')}">
        <span class="swatch" style="background:${featureColor(doc, f)}"></span>
        <span class="icon">${TYPE_ICON[f.type] || '?'}</span>
        <span class="name">${esc(f.name || f.id)}</span>
        <span class="fid">${f.name ? esc(f.id) : ''}</span>
      </li>`,
      )
      .join('') + imageRows;
}

function renderToolbar() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  svg.classList.toggle('drawing', state.tool !== 'select');
  $('#hint').textContent = HINTS[state.tool];
  const cats = state.doc?.categories || {};
  if (state.drawCategory && !(state.drawCategory in cats)) state.drawCategory = '';
  $('#draw-category').innerHTML =
    `<option value="">(no category)</option>` +
    Object.keys(cats)
      .map((id) => `<option value="${esc(id)}" ${id === state.drawCategory ? 'selected' : ''}>${esc(id)}</option>`)
      .join('');
}

function renderBanner() {
  const el = $('#banner');
  if (!state.diskErrors) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<strong>map.json on disk has errors — editing is paused until it is fixed.</strong>
    <ul>${state.diskErrors
      .slice(0, 8)
      .map((e) => `<li>${esc(e)}</li>`)
      .join('')}</ul>
    ${state.doc ? '<button data-action="overwrite">Overwrite map.json with the last good version</button>' : ''}`;
}

function renderAll() {
  render();
  renderList();
  renderTitle();
  renderToolbar();
  renderInspector();
}

// ---------------------------------------------------------------- inspector

function field(label, inner, cls = '') {
  return `<label class="field ${cls}"><span>${label}</span>${inner}</label>`;
}

function formatPropValue(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function parsePropValue(s) {
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* keep as string */
    }
  }
  return s;
}

function featureStats(f, units) {
  const b = bbox(f.points);
  const lines = [];
  if (f.type === 'area') {
    lines.push(`${f.points.length} corners · area ${fmtNum(polygonArea(f.points))} ${units}²`);
    lines.push(`x ${fmtNum(b.minX)}–${fmtNum(b.maxX)}, y ${fmtNum(b.minY)}–${fmtNum(b.maxY)}`);
  } else if (f.type === 'line') {
    lines.push(`${f.points.length} points · length ${fmtNum(polylineLength(f.points))} ${units}`);
    lines.push(
      `from (${f.points[0].map(fmtNum).join(', ')}) to (${f.points[f.points.length - 1].map(fmtNum).join(', ')})`,
    );
  } else {
    lines.push(`at (${f.points[0].map(fmtNum).join(', ')})`);
  }
  return lines.join('<br>');
}

function featureInspector(f) {
  const doc = state.doc;
  const units = doc.units || 'units';
  const catOptions =
    `<option value="">(none)</option>` +
    Object.keys(doc.categories || {})
      .map((id) => `<option value="${esc(id)}" ${id === f.category ? 'selected' : ''}>${esc(id)}</option>`)
      .join('');
  const props = Object.entries(f.props || {});
  let html = `<h2>${TYPE_ICON[f.type]} Feature <span class="type-badge">${f.type}</span></h2>`;
  html += field(
    'Name',
    `<input type="text" data-field="f.name" value="${esc(f.name || '')}" placeholder="e.g. Silver River">`,
  );
  html += field('ID (stable reference for agents)', `<input type="text" data-field="f.id" value="${esc(f.id)}">`);
  html += field('Category', `<select data-field="f.category">${catOptions}</select>`);
  html += field(
    'Color override',
    `<div class="inline"><input type="color" data-field="f.color" value="${featureColor(doc, f)}"><span class="muted fixed">${f.color ? 'custom' : 'from category'}</span>${f.color ? '<button data-action="clear-color">Reset</button>' : ''}</div>`,
  );
  html += field(
    'Notes — design intent, in plain language',
    `<textarea data-field="f.notes" rows="5" placeholder="What is this? How should it look, feel, play?">${esc(f.notes || '')}</textarea>`,
  );
  if (f.type === 'line') {
    html += field(
      `Width (${esc(units)}, optional)`,
      `<input type="number" min="0" step="any" data-field="f.width" value="${f.width ?? ''}" placeholder="e.g. 30 for a river">`,
    );
    html += `<label class="field check"><input type="checkbox" data-field="f.directed" ${f.directed ? 'checked' : ''}><span>Directed (flows from first point to last)</span></label>`;
  }
  html += `<h3>Properties</h3>`;
  html += props
    .map(
      ([k, v], i) => `<div class="row">
        <input type="text" class="key" data-field="prop-key" data-index="${i}" value="${esc(k)}" placeholder="key">
        <input type="text" data-field="prop-val" data-index="${i}" value="${esc(formatPropValue(v))}" placeholder="value">
        <button data-action="remove-prop" data-index="${i}" title="Remove">×</button>
      </div>`,
    )
    .join('');
  html += `<button data-action="add-prop">+ Add property</button>`;
  html += `<div class="stats">${featureStats(f, esc(units))}</div>`;
  html += `<div class="actions">
    <button data-action="zoom-to">Zoom to</button>
    <button data-action="front">Bring to front</button>
    <button data-action="back">Send to back</button>
    ${f.type === 'line' ? '<button data-action="reverse">Reverse direction</button>' : ''}
    <button data-action="delete" class="danger">Delete</button>
  </div>`;
  return html;
}

function imageInspector(img) {
  const units = esc(state.doc.units || 'units');
  const numField = (label, key) =>
    field(label, `<input type="number" step="any" data-field="i.${key}" value="${round(img[key], 3)}">`);
  let html = `<h2>▣ Image <span class="type-badge">${esc(img.file)}</span></h2>`;
  html += field(
    'Name',
    `<input type="text" data-field="i.name" value="${esc(img.name || '')}" placeholder="e.g. Terrain sketch">`,
  );
  html += field('ID', `<input type="text" data-field="i.id" value="${esc(img.id)}">`);
  html += `<div class="inline">${numField(`X (${units})`, 'x')}${numField(`Y (${units})`, 'y')}</div>`;
  html += `<div class="inline">${numField('Width', 'width')}${numField('Height', 'height')}</div>`;
  html += `<div class="muted" style="margin:-4px 0 8px">Changing width or height keeps the aspect ratio. Drag corners on the map to resize (hold Shift to stretch).</div>`;
  html += field(
    'Opacity',
    `<input type="range" min="0" max="1" step="0.05" data-field="i.opacity" value="${img.opacity ?? 1}">`,
  );
  html += `<label class="field check"><input type="checkbox" data-field="i.locked" ${img.locked ? 'checked' : ''}><span>Locked (can't be moved, clicks pass through to the map)</span></label>`;
  html += field(
    'Notes — what this image shows, how reliable it is',
    `<textarea data-field="i.notes" rows="3" placeholder="e.g. Rough terrain sketch; coastline is accurate, hills are not">${esc(img.notes || '')}</textarea>`,
  );
  html += `<div class="actions">
    <button data-action="zoom-to">Zoom to</button>
    <button data-action="image-fit-frame">Fit into map frame</button>
    <button data-action="frame-to-image">Set map frame to image</button>
    <button data-action="front">Bring forward</button>
    <button data-action="back">Send backward</button>
    <button data-action="delete" class="danger">Remove</button>
  </div>`;
  return html;
}

function mapInspector() {
  const doc = state.doc;
  let html = `<h2>Map</h2>`;
  html += field('Name', `<input type="text" data-field="m.name" value="${esc(doc.name || '')}">`);
  html += field(
    'Notes — overall vision, style, constraints',
    `<textarea data-field="m.notes" rows="5" placeholder="What is this map? Genre, scale, mood, how players move through it…">${esc(doc.notes || '')}</textarea>`,
  );
  html += `<div class="inline">
    ${field('Frame width', `<input type="number" min="0" step="any" data-field="m.width" value="${doc.bounds.width}">`)}
    ${field('Frame height', `<input type="number" min="0" step="any" data-field="m.height" value="${doc.bounds.height}">`)}
    ${field('Units', `<input type="text" data-field="m.units" value="${esc(doc.units || '')}" placeholder="m">`)}
  </div>`;
  html += `<div class="muted" style="margin:-4px 0 8px">The map frame (0, 0 to width, height) is a reference; the canvas itself is unbounded.</div>`;
  html += `<h3>Images</h3>`;
  html += `<div class="muted" style="margin-bottom:6px">Terrain drawings, sketches, satellite or map screenshots to annotate on top of. Images sit beneath all features and appear in preview.png. You can also paste (Ctrl+V) or drop images onto the map.</div>`;
  html += `<button data-action="image-add">Add image…</button>`;
  html += `<h3>Categories</h3>`;
  html += Object.entries(doc.categories || {})
    .map(
      ([id, c]) => `<div class="row">
        <input type="color" data-field="c.color" data-cat="${esc(id)}" value="${c.color}">
        <input type="text" class="key" data-field="c.id" data-cat="${esc(id)}" value="${esc(id)}">
        <input type="text" data-field="c.description" data-cat="${esc(id)}" value="${esc(c.description || '')}" placeholder="description">
        <button data-action="cat-remove" data-cat="${esc(id)}" title="Remove">×</button>
      </div>`,
    )
    .join('');
  html += `<button data-action="cat-add">+ Add category</button>`;
  html += `<p class="muted" style="margin-top:14px">Select a feature on the map or in the list to edit it.</p>`;
  return html;
}

function renderInspector() {
  if (!state.doc) {
    inspector.innerHTML = '';
    return;
  }
  // Keep focus and caret if the inspector is rebuilt while typing (e.g. an agent edited the file).
  const active = document.activeElement;
  const focusKey = inspector.contains(active)
    ? `${active.dataset.field}|${active.dataset.index ?? ''}|${active.dataset.cat ?? ''}`
    : null;
  const caret = focusKey && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  const f = selected();
  const img = selectedImage();
  const body = f ? featureInspector(f) : img ? imageInspector(img) : mapInspector();
  inspector.innerHTML = `<fieldset ${state.diskErrors ? 'disabled' : ''}>${body}</fieldset>`;

  if (focusKey) {
    const el = [...inspector.querySelectorAll('[data-field]')].find(
      (e) => `${e.dataset.field}|${e.dataset.index ?? ''}|${e.dataset.cat ?? ''}` === focusKey,
    );
    if (el) {
      el.focus();
      if (caret) {
        try {
          el.setSelectionRange(...caret);
        } catch {
          /* not a text input */
        }
      }
    }
  }
}

function readPropsFromInspector() {
  const keys = inspector.querySelectorAll('[data-field="prop-key"]');
  const vals = inspector.querySelectorAll('[data-field="prop-val"]');
  const props = {};
  keys.forEach((k, i) => {
    if (k.value.trim()) props[k.value.trim()] = parsePropValue(vals[i].value);
  });
  return props;
}

function setProps(f, props) {
  if (Object.keys(props).length) f.props = props;
  else delete f.props;
}

// Continuous edits (typing, color dragging).
inspector.addEventListener('input', (e) => {
  const el = e.target;
  const key = el.dataset.field;
  if (!key || readOnly()) return;
  const doc = state.doc;
  const f = selected();
  const v = el.value;
  switch (key) {
    case 'f.name':
    case 'f.notes':
      checkpoint(`${key}:${f.id}`);
      f[key.slice(2)] = v;
      break;
    case 'f.color':
      checkpoint(`${key}:${f.id}`);
      f.color = v;
      break;
    case 'f.width':
      checkpoint(`${key}:${f.id}`);
      if (v === '' || !(Number(v) >= 0)) delete f.width;
      else f.width = Number(v);
      break;
    case 'prop-key':
    case 'prop-val':
      checkpoint(`props:${f.id}`);
      setProps(f, readPropsFromInspector());
      break;
    case 'm.name':
    case 'm.notes':
    case 'm.units':
      checkpoint(key);
      doc[key.slice(2)] = v;
      break;
    case 'i.name':
    case 'i.notes': {
      const img = selectedImage();
      checkpoint(`${key}:${img.id}`);
      if (v) img[key.slice(2)] = v;
      else delete img[key.slice(2)];
      break;
    }
    case 'i.opacity': {
      const img = selectedImage();
      checkpoint(`${key}:${img.id}`);
      img.opacity = Number(v);
      break;
    }
    case 'c.color':
      checkpoint(`${key}:${el.dataset.cat}`);
      doc.categories[el.dataset.cat].color = v;
      break;
    case 'c.description':
      checkpoint(`${key}:${el.dataset.cat}`);
      doc.categories[el.dataset.cat].description = v;
      break;
    default:
      return;
  }
  changed();
});

// Discrete edits (committed on blur/enter/select).
inspector.addEventListener('change', (e) => {
  const el = e.target;
  const key = el.dataset.field;
  if (!key || readOnly()) return;
  const doc = state.doc;
  const f = selected();
  switch (key) {
    case 'f.id': {
      const id = el.value.trim();
      if (id === f.id) return;
      if (!ID_PATTERN.test(id)) {
        toast('IDs may contain letters, digits, "-", "_" and "." and must start with a letter or digit.', 'error');
        el.value = f.id;
        return;
      }
      if (idTaken(id)) {
        toast(`Another feature or image already uses the id "${id}".`, 'error');
        el.value = f.id;
        return;
      }
      checkpoint();
      f.id = id;
      state.selectedId = id;
      break;
    }
    case 'f.category':
      checkpoint();
      if (el.value) f.category = el.value;
      else delete f.category;
      changed({ inspector: true });
      return;
    case 'f.directed':
      checkpoint();
      if (el.checked) f.directed = true;
      else delete f.directed;
      break;
    case 'i.id': {
      const img = selectedImage();
      const id = el.value.trim();
      if (id === img.id) return;
      if (!ID_PATTERN.test(id) || idTaken(id)) {
        toast('Image ids must be unique and use letters, digits, "-", "_" or ".".', 'error');
        el.value = img.id;
        return;
      }
      checkpoint();
      img.id = id;
      state.selectedId = id;
      break;
    }
    case 'i.x':
    case 'i.y':
    case 'i.width':
    case 'i.height': {
      const img = selectedImage();
      const k = key.slice(2);
      const n = Number(el.value);
      const size = k === 'width' || k === 'height';
      if (el.value === '' || !Number.isFinite(n) || (size && n <= 0)) {
        el.value = round(img[k], 3);
        return;
      }
      checkpoint();
      if (k === 'width') img.height = round((img.height * n) / img.width, 3);
      if (k === 'height') img.width = round((img.width * n) / img.height, 3);
      img[k] = n;
      changed({ inspector: true });
      return;
    }
    case 'i.locked': {
      checkpoint();
      const img = selectedImage();
      if (el.checked) img.locked = true;
      else delete img.locked;
      changed({ inspector: true });
      return;
    }
    case 'm.width':
    case 'm.height': {
      const n = Number(el.value);
      if (!(n > 0)) {
        el.value = doc.bounds[key.slice(2)];
        return;
      }
      checkpoint();
      doc.bounds[key.slice(2)] = n;
      break;
    }
    case 'c.id': {
      const oldId = el.dataset.cat;
      const id = el.value.trim();
      if (id === oldId) return;
      if (!ID_PATTERN.test(id) || id in doc.categories) {
        toast('Category ids must be unique and use letters, digits, "-", "_" or ".".', 'error');
        el.value = oldId;
        return;
      }
      checkpoint();
      // Rebuild to keep the category order stable.
      doc.categories = Object.fromEntries(Object.entries(doc.categories).map(([k, c]) => [k === oldId ? id : k, c]));
      for (const feat of doc.features) if (feat.category === oldId) feat.category = id;
      if (state.drawCategory === oldId) state.drawCategory = id;
      renderToolbar();
      changed({ inspector: true });
      return;
    }
    default:
      return;
  }
  changed();
});

inspector.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || readOnly()) return;
  const doc = state.doc;
  const f = selected();
  const img = selectedImage();
  const i = Number(btn.dataset.index);
  switch (btn.dataset.action) {
    case 'delete':
      deleteSelected();
      return;
    case 'zoom-to':
      zoomToId(state.selectedId);
      return;
    case 'front':
    case 'back': {
      checkpoint();
      if (img) {
        doc.images = doc.images.filter((x) => x !== img);
        if (btn.dataset.action === 'front') doc.images.push(img);
        else doc.images.unshift(img);
        break;
      }
      doc.features = doc.features.filter((x) => x !== f);
      if (btn.dataset.action === 'front') doc.features.push(f);
      else doc.features.unshift(f);
      break;
    }
    case 'reverse':
      checkpoint();
      f.points.reverse();
      break;
    case 'clear-color':
      checkpoint();
      delete f.color;
      break;
    case 'add-prop': {
      checkpoint();
      const props = { ...(f.props || {}) };
      let k = 'key';
      for (let n = 2; k in props; n++) k = `key${n}`;
      props[k] = '';
      f.props = props;
      changed({ inspector: true });
      const keys = inspector.querySelectorAll('[data-field="prop-key"]');
      keys[keys.length - 1]?.select();
      return;
    }
    case 'remove-prop': {
      checkpoint();
      const entries = Object.entries(f.props || {}).filter((_, j) => j !== i);
      setProps(f, Object.fromEntries(entries));
      break;
    }
    case 'image-add':
      $('#image-file').click();
      return;
    case 'image-fit-frame': {
      checkpoint();
      Object.assign(
        img,
        containRect(img.width / img.height, { minX: 0, minY: 0, maxX: doc.bounds.width, maxY: doc.bounds.height }),
      );
      break;
    }
    case 'frame-to-image': {
      // Move the frame's origin to the image's top-left by shifting everything.
      checkpoint();
      const dx = img.x;
      const dy = img.y;
      for (const other of doc.images) {
        other.x = round(other.x - dx, 3);
        other.y = round(other.y - dy, 3);
      }
      for (const feat of doc.features) feat.points = feat.points.map(([x, y]) => [round(x - dx, 3), round(y - dy, 3)]);
      doc.bounds = { width: round(img.width, 3), height: round(img.height, 3) };
      state.view.x -= dx;
      state.view.y -= dy;
      toast('The map frame now matches this image. Everything was shifted so the image starts at (0, 0).');
      break;
    }
    case 'cat-add': {
      checkpoint();
      let id = 'category';
      for (let n = 2; id in doc.categories; n++) id = `category-${n}`;
      doc.categories[id] = { color: '#0d9488', description: '' };
      renderToolbar();
      changed({ inspector: true });
      const ids = inspector.querySelectorAll('[data-field="c.id"]');
      ids[ids.length - 1]?.select();
      return;
    }
    case 'cat-remove': {
      const id = btn.dataset.cat;
      const used = doc.features.filter((x) => x.category === id).length;
      if (used && !confirm(`${used} feature(s) use "${id}". Remove the category from them too?`)) return;
      checkpoint();
      delete doc.categories[id];
      for (const feat of doc.features) if (feat.category === id) delete feat.category;
      renderToolbar();
      break;
    }
    default:
      return;
  }
  changed({ inspector: true });
});

$('#image-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) await addImageFile(file);
});

/** Largest rect with the given aspect ratio that fits centered inside `box`. */
function containRect(aspect, box, fill = 1) {
  const bw = (box.maxX - box.minX) * fill;
  const bh = (box.maxY - box.minY) * fill;
  const width = Math.min(bw, bh * aspect);
  const height = width / aspect;
  const x = (box.minX + box.maxX) / 2 - width / 2;
  const y = (box.minY + box.maxY) / 2 - height / 2;
  return { x: round(x, 3), y: round(y, 3), width: round(width, 3), height: round(height, 3) };
}

function imageExt(file) {
  const fromName = file.name?.match(/\.(png|jpe?g|webp|gif)$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  return { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type] || 'png';
}

/**
 * Uploads an image into the map folder and adds it as a layer. With no images
 * or features yet it becomes the base layer and the map frame is sized to it;
 * otherwise it is placed in the middle of the view (or at `at`, for drops).
 */
async function addImageFile(file, { at = null } = {}) {
  if (readOnly() || !file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    if (file) toast('Only PNG, JPEG, WebP and GIF images are supported.', 'error');
    return;
  }
  const stem = (file.name || 'pasted-image').replace(/\.[^.]+$/, '');
  const res = await fetch(`/api/upload?name=${encodeURIComponent(`${stem}.${imageExt(file)}`)}`, {
    method: 'POST',
    body: file,
  });
  if (!res.ok) {
    toast('Image upload failed', 'error');
    return;
  }
  const { file: saved } = await res.json();
  const probe = new Image();
  probe.src = URL.createObjectURL(file);
  await probe.decode().catch(() => {});
  URL.revokeObjectURL(probe.src);
  const aspect = probe.naturalWidth && probe.naturalHeight ? probe.naturalWidth / probe.naturalHeight : 1;

  const doc = state.doc;
  checkpoint();
  doc.images = doc.images || [];
  const first = !doc.images.length && !doc.features.length;
  let rect;
  if (first) {
    doc.bounds.height = round(doc.bounds.width / aspect, 3);
    rect = { x: 0, y: 0, width: doc.bounds.width, height: doc.bounds.height };
  } else {
    const u = 1 / state.view.scale;
    const view = {
      minX: state.view.x,
      minY: state.view.y,
      maxX: state.view.x + svg.clientWidth * u,
      maxY: state.view.y + svg.clientHeight * u,
    };
    rect = containRect(aspect, view, 0.6);
    if (at) {
      rect.x = round(at[0] - rect.width / 2, 3);
      rect.y = round(at[1] - rect.height / 2, 3);
    }
  }
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
  // Names like "1.png" or "Screenshot 2026-09-28" make poor ids; fall back to "image".
  const base = /[a-z]{2}/.test(slug) && !/^screenshot/.test(slug) ? slug : 'image';
  const id = idTaken(base) ? nextId(base) : base;
  const img = { id, file: saved, ...rect, opacity: 1 };
  if (first) img.locked = true;
  doc.images.push(img);
  state.selectedId = id;
  state.tool = 'select';
  renderToolbar();
  changed({ inspector: true });
  if (first) {
    fitView();
    toast(
      'Image added as the base layer; the map frame now matches it. It is locked, so you can draw and pan over it freely.',
    );
  } else {
    toast('Image added. Drag it or its corners to place it, then tick "Locked" in the sidebar.');
  }
}

// ------------------------------------------------------------------ editing

function select(id) {
  state.selectedId = id;
  render();
  renderList();
  renderInspector();
}

function setTool(tool) {
  if (state.draft) state.draft = null;
  state.tool = tool;
  renderToolbar();
  render();
}

function deleteSelected() {
  const f = selected();
  const img = selectedImage();
  if ((!f && !img) || readOnly()) return;
  checkpoint();
  if (f) state.doc.features = state.doc.features.filter((x) => x !== f);
  else state.doc.images = state.doc.images.filter((x) => x !== img);
  state.selectedId = null;
  changed({ inspector: true });
}

function addFeature(type, points) {
  checkpoint();
  const f = { id: nextId(type), type, name: '' };
  if (state.drawCategory) f.category = state.drawCategory;
  f.notes = '';
  f.points = points;
  state.doc.features.push(f);
  state.selectedId = f.id;
  state.tool = 'select';
  renderToolbar();
  changed({ inspector: true });
  inspector.querySelector('[data-field="f.name"]')?.focus();
}

function finishDraft() {
  const d = state.draft;
  if (!d) return;
  // Drop accidental repeated clicks on the same spot.
  const tol = 4 / state.view.scale;
  const pts = d.points.filter(
    (p, i) => i === 0 || Math.hypot(p[0] - d.points[i - 1][0], p[1] - d.points[i - 1][1]) > tol,
  );
  if (pts.length < MIN_POINTS[d.type]) {
    toast(`An ${d.type} needs at least ${MIN_POINTS[d.type]} points.`);
    return;
  }
  state.draft = null;
  addFeature(d.type, pts);
}

// ------------------------------------------------------------ view & input

function toWorld(e) {
  const r = svg.getBoundingClientRect();
  const { x, y, scale } = state.view;
  return [x + (e.clientX - r.left) / scale, y + (e.clientY - r.top) / scale];
}

function fitRect(minX, minY, maxX, maxY, pad = 0.08) {
  const w = svg.clientWidth || 800;
  const h = svg.clientHeight || 600;
  const bw = Math.max(maxX - minX, 1e-6);
  const bh = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((w * (1 - 2 * pad)) / bw, (h * (1 - 2 * pad)) / bh);
  state.view = { scale, x: (minX + maxX) / 2 - w / 2 / scale, y: (minY + maxY) / 2 - h / 2 / scale };
  render();
}

function fitView() {
  if (!state.doc) return;
  const e = mapExtent(state.doc);
  fitRect(e.minX, e.minY, e.maxX, e.maxY);
}

function zoomToId(id) {
  const f = getFeature(id);
  const img = getImage(id);
  if (!f && !img) return;
  const b = f ? bbox(f.points) : { minX: img.x, minY: img.y, maxX: img.x + img.width, maxY: img.y + img.height };
  const minSize = Math.max(state.doc.bounds.width, state.doc.bounds.height) * 0.08;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hw = Math.max((b.maxX - b.minX) / 2, minSize / 2);
  const hh = Math.max((b.maxY - b.minY) / 2, minSize / 2);
  fitRect(cx - hw, cy - hh, cx + hw, cy + hh, 0.2);
}

let drag = null;
let spaceDown = false;
let lastDrawClick = { t: 0, x: 0, y: 0 };

svg.addEventListener('contextmenu', (e) => e.preventDefault());

svg.addEventListener('pointerdown', (e) => {
  if (!state.doc) return;
  const w = toWorld(e);
  const startPan = () => {
    drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, view: { ...state.view } };
    svg.classList.add('panning');
    svg.setPointerCapture(e.pointerId);
  };
  if (e.button === 1 || spaceDown) return startPan();
  if (readOnly()) return e.button === 0 ? startPan() : undefined;

  if (state.tool !== 'select') {
    if (e.button === 2) {
      if (state.draft) finishDraft();
      return;
    }
    if (e.button !== 0) return;
    if (state.tool === 'point') return addFeature('point', [roundPt(w)]);
    // Detect double-clicks ourselves: the canvas re-renders between clicks, so native dblclick is unreliable.
    const now = performance.now();
    const last = lastDrawClick;
    lastDrawClick = { t: now, x: e.clientX, y: e.clientY };
    if (state.draft && now - last.t < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6) {
      lastDrawClick = { t: 0, x: 0, y: 0 };
      return finishDraft();
    }
    if (!state.draft) state.draft = { type: state.tool, points: [] };
    state.draft.points.push(roundPt(w));
    render();
    return;
  }

  if (e.button !== 0) return;
  const target = e.target.closest('[data-vertex],[data-mid],[data-corner],[data-fid],[data-img]');
  const f = selected();
  const selImg = selectedImage();
  if (target?.dataset.corner !== undefined && selImg) {
    const c = Number(target.dataset.corner);
    const { x, y, width, height } = selImg;
    // The corner opposite the dragged one stays put.
    const anchor = [c === 1 || c === 2 ? x : x + width, c === 2 || c === 3 ? y : y + height];
    drag = { kind: 'resize-image', corner: c, anchor, aspect: width / height, moved: false };
  } else if (target?.dataset.img !== undefined) {
    const id = target.dataset.img;
    if (id !== state.selectedId) select(id);
    const img = getImage(id);
    drag = { kind: 'move-image', start: w, orig: [img.x, img.y], moved: false };
  } else if (target?.dataset.vertex !== undefined && f) {
    const idx = Number(target.dataset.vertex);
    if (e.altKey) {
      if (f.type === 'point' || f.points.length <= MIN_POINTS[f.type]) {
        toast(`An ${f.type} needs at least ${MIN_POINTS[f.type] ?? 1} points.`);
        return;
      }
      checkpoint();
      f.points.splice(idx, 1);
      changed({ inspector: true });
      return;
    }
    drag = { kind: 'vertex', idx, moved: false };
  } else if (target?.dataset.mid !== undefined && f) {
    const idx = Number(target.dataset.mid) + 1;
    checkpoint();
    f.points.splice(idx, 0, roundPt(w));
    drag = { kind: 'vertex', idx, moved: true };
    changed();
  } else if (target?.dataset.fid !== undefined) {
    const id = target.dataset.fid;
    if (id !== state.selectedId) select(id);
    drag = { kind: 'move', start: w, orig: getFeature(id).points.map((p) => [...p]), moved: false };
  } else {
    if (state.selectedId) select(null);
    return startPan();
  }
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', (e) => {
  if (!state.doc) return;
  const w = toWorld(e);
  state.cursor = roundPt(w);
  const u = state.doc.units || '';
  $('#cursor-pos').textContent = `x ${num(state.cursor[0])}, y ${num(state.cursor[1])} ${u}`;
  if (!drag) {
    if (state.draft) render();
    return;
  }
  if (drag.kind === 'pan') {
    const s = drag.view.scale;
    state.view.x = drag.view.x - (e.clientX - drag.cx) / s;
    state.view.y = drag.view.y - (e.clientY - drag.cy) / s;
    render();
    return;
  }
  if (drag.kind === 'move-image' || drag.kind === 'resize-image') {
    const img = selectedImage();
    if (!img) return;
    if (!drag.moved) {
      checkpoint();
      drag.moved = true;
    }
    const d = coordDigits();
    if (drag.kind === 'move-image') {
      img.x = round(drag.orig[0] + w[0] - drag.start[0], d);
      img.y = round(drag.orig[1] + w[1] - drag.start[1], d);
    } else {
      const sx = drag.corner === 1 || drag.corner === 2 ? 1 : -1;
      const sy = drag.corner === 2 || drag.corner === 3 ? 1 : -1;
      const [ax, ay] = drag.anchor;
      const min = 4 / state.view.scale;
      let width = Math.max(min, (w[0] - ax) * sx);
      let height = Math.max(min, (w[1] - ay) * sy);
      if (!e.shiftKey) {
        // Keep the aspect ratio, following whichever axis the pointer moved further along.
        if (width / drag.aspect > height) height = width / drag.aspect;
        else width = height * drag.aspect;
      }
      img.width = round(width, d);
      img.height = round(height, d);
      img.x = round(sx > 0 ? ax : ax - width, d);
      img.y = round(sy > 0 ? ay : ay - height, d);
    }
    render();
    return;
  }
  const f = selected();
  if (!f) return;
  if (!drag.moved) {
    checkpoint();
    drag.moved = true;
  }
  if (drag.kind === 'vertex') {
    f.points[drag.idx] = roundPt(w);
  } else {
    const dx = w[0] - drag.start[0];
    const dy = w[1] - drag.start[1];
    f.points = drag.orig.map(([x, y]) => roundPt([x + dx, y + dy]));
  }
  render();
});

function endDrag() {
  if (!drag) return;
  const wasEdit = drag.kind !== 'pan' && drag.moved;
  drag = null;
  svg.classList.toggle('panning', spaceDown);
  if (wasEdit) changed({ inspector: true });
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

svg.addEventListener('pointerleave', () => {
  state.cursor = null;
  $('#cursor-pos').textContent = '—';
  if (state.draft) render();
});

svg.addEventListener(
  'wheel',
  (e) => {
    if (!state.doc) return;
    e.preventDefault();
    const [wx, wy] = toWorld(e);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    const scale = Math.min(Math.max(state.view.scale * factor, 1e-4), 1e4);
    const r = svg.getBoundingClientRect();
    state.view = { scale, x: wx - (e.clientX - r.left) / scale, y: wy - (e.clientY - r.top) / scale };
    render();
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select');
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && (k === 'z' || k === 'y')) {
    if (typing) return; // native text undo
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo();
    else undo();
    return;
  }
  if (typing) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (mod || $('#help').open) return;
  if (e.key === ' ') {
    spaceDown = true;
    svg.classList.add('panning');
    e.preventDefault();
    return;
  }
  const tools = { v: 'select', a: 'area', l: 'line', p: 'point' };
  if (tools[k]) return setTool(tools[k]);
  if (k === 'f') return fitView();
  if (e.key === 'Escape') {
    if (state.draft) {
      state.draft = null;
      render();
    } else if (state.tool !== 'select') setTool('select');
    else select(null);
    return;
  }
  if (e.key === 'Enter' && state.draft) return finishDraft();
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (state.draft) {
      state.draft.points.pop();
      if (!state.draft.points.length) state.draft = null;
      render();
    } else deleteSelected();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    if (!drag) svg.classList.remove('panning');
  }
});

window.addEventListener('resize', render);

window.addEventListener('beforeunload', (e) => {
  if (state.saveTimer || state.saving) e.preventDefault();
});

// ----------------------------------------------------------------- toolbar

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#draw-category').addEventListener('change', (e) => (state.drawCategory = e.target.value));
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-fit').addEventListener('click', fitView);
$('#btn-help').addEventListener('click', () => $('#help').showModal());

$('#feature-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-id]');
  if (li) select(li.dataset.id);
});
$('#feature-list').addEventListener('dblclick', (e) => {
  const li = e.target.closest('[data-id]');
  if (li) zoomToId(li.dataset.id);
});

$('#btn-image').addEventListener('click', () => !readOnly() && $('#image-file').click());

// Paste an image (e.g. a map screenshot) straight from the clipboard.
window.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  files.forEach((f) => addImageFile(f));
});

svg.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
svg.addEventListener('drop', async (e) => {
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) await addImageFile(f, { at: toWorld(e) });
});

$('#banner').addEventListener('click', (e) => {
  if (e.target.closest('[data-action="overwrite"]')) save({ force: true });
});

// ------------------------------------------------------------------- sync

async function load() {
  const res = await fetch('/api/map');
  const data = await res.json();
  if (data.errors?.length) {
    adopt(data);
    renderAll();
  } else if (data.rev !== state.rev || state.diskErrors) {
    adopt({ ...data, silent: true }, { external: !!state.doc });
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') {
      // After a reconnect (e.g. server restart) re-sync with the file on disk.
      if (state.connectedOnce) load();
      state.connectedOnce = true;
    } else if (msg.type === 'map') {
      if (msg.source === clientId) return;
      if (!msg.errors?.length && msg.rev === state.rev && !state.diskErrors) return;
      adopt(msg, { external: true });
    }
  };
  es.onerror = () => setStatus('Disconnected — is the server running?', true);
}

renderToolbar();
load().then(connect);
