// Shared document model: used by the browser app, the local server and the CLI.
// No dependencies, no DOM access — keep it that way so it runs everywhere.

export const FORMAT = 'map-annotation/1';
export const FEATURE_TYPES = ['area', 'line', 'point'];
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_CATEGORIES = {
  water: { color: '#3b82f6', description: 'Rivers, lakes, coastlines' },
  terrain: { color: '#8b7355', description: 'Hills, mountains, cliffs, elevation changes' },
  vegetation: { color: '#22a045', description: 'Forests, fields, jungles' },
  settlement: { color: '#f59e0b', description: 'Towns, camps, buildings, districts' },
  route: { color: '#a8a29e', description: 'Roads, paths, bridges, travel lanes' },
  gameplay: { color: '#a855f7', description: 'Spawns, objectives, combat zones, points of interest' },
  note: { color: '#ef4444', description: 'Comments, questions and open design issues' },
};

export function createMap({ name = 'Untitled map', width = 1000, height = 1000, units = 'm' } = {}) {
  return {
    format: FORMAT,
    name,
    notes: '',
    units,
    bounds: { width, height },
    background: null,
    categories: structuredClone(DEFAULT_CATEGORIES),
    features: [],
  };
}

// ---------------------------------------------------------------- validation

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function isPoint(p) {
  return Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]);
}

const MIN_POINTS = { area: 3, line: 2, point: 1 };

/** Returns { errors: string[], warnings: string[] }. A document with no errors is valid. */
export function validateMap(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { errors: ['document must be a JSON object'], warnings };
  }
  if (doc.format !== FORMAT) errors.push(`"format" must be "${FORMAT}"`);
  if (doc.name !== undefined && typeof doc.name !== 'string') errors.push('"name" must be a string');
  if (doc.notes !== undefined && typeof doc.notes !== 'string') errors.push('"notes" must be a string');
  if (doc.units !== undefined && typeof doc.units !== 'string') errors.push('"units" must be a string');

  const b = doc.bounds;
  if (!b || !isNum(b.width) || !isNum(b.height) || b.width <= 0 || b.height <= 0) {
    errors.push('"bounds" must be { "width": >0, "height": >0 }');
  }

  if (doc.background !== undefined && doc.background !== null) {
    const bg = doc.background;
    if (typeof bg !== 'object' || typeof bg.image !== 'string' || !bg.image) {
      errors.push('"background" must be null or { "image": "<file in the map folder>", "opacity"?: 0..1 }');
    } else if (bg.opacity !== undefined && (!isNum(bg.opacity) || bg.opacity < 0 || bg.opacity > 1)) {
      errors.push('"background.opacity" must be a number between 0 and 1');
    }
  }

  const cats = doc.categories ?? {};
  if (typeof cats !== 'object' || Array.isArray(cats)) {
    errors.push('"categories" must be an object keyed by category id');
  } else {
    for (const [key, c] of Object.entries(cats)) {
      if (!ID_PATTERN.test(key)) errors.push(`category id "${key}" must match ${ID_PATTERN}`);
      if (!c || typeof c !== 'object') {
        errors.push(`category "${key}" must be an object`);
        continue;
      }
      if (!HEX_COLOR.test(c.color ?? '')) errors.push(`category "${key}".color must be a hex color like "#3b82f6"`);
      if (c.description !== undefined && typeof c.description !== 'string') {
        errors.push(`category "${key}".description must be a string`);
      }
    }
  }

  if (!Array.isArray(doc.features)) {
    errors.push('"features" must be an array');
    return { errors, warnings };
  }

  const seen = new Set();
  doc.features.forEach((f, i) => {
    const where = f && typeof f.id === 'string' ? `feature "${f.id}"` : `features[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof f.id !== 'string' || !ID_PATTERN.test(f.id)) {
      errors.push(`${where}: "id" must be a string matching ${ID_PATTERN}`);
    } else if (seen.has(f.id)) {
      errors.push(`${where}: duplicate id`);
    } else {
      seen.add(f.id);
    }
    if (!FEATURE_TYPES.includes(f.type)) {
      errors.push(`${where}: "type" must be one of ${FEATURE_TYPES.join(', ')}`);
    }
    if (!Array.isArray(f.points) || !f.points.every(isPoint)) {
      errors.push(`${where}: "points" must be an array of [x, y] number pairs`);
    } else if (FEATURE_TYPES.includes(f.type)) {
      const min = MIN_POINTS[f.type];
      if (f.type === 'point' && f.points.length !== 1) errors.push(`${where}: a point needs exactly 1 point`);
      else if (f.points.length < min) errors.push(`${where}: a ${f.type} needs at least ${min} points`);
      if (b && isNum(b.width) && isNum(b.height)) {
        const out = f.points.some(([x, y]) => x < 0 || y < 0 || x > b.width || y > b.height);
        if (out) warnings.push(`${where}: some points lie outside the map bounds`);
      }
    }
    for (const key of ['name', 'notes', 'category']) {
      if (f[key] !== undefined && typeof f[key] !== 'string') errors.push(`${where}: "${key}" must be a string`);
    }
    if (f.category && cats && typeof cats === 'object' && !(f.category in cats)) {
      warnings.push(`${where}: category "${f.category}" is not defined in "categories"`);
    }
    if (f.color !== undefined && !HEX_COLOR.test(f.color)) errors.push(`${where}: "color" must be a hex color`);
    if (f.directed !== undefined && typeof f.directed !== 'boolean')
      errors.push(`${where}: "directed" must be a boolean`);
    if (f.directed && f.type !== 'line') warnings.push(`${where}: "directed" only has meaning on lines`);
    if (f.width !== undefined && (!isNum(f.width) || f.width < 0))
      errors.push(`${where}: "width" must be a number >= 0`);
    if (f.props !== undefined && (typeof f.props !== 'object' || f.props === null || Array.isArray(f.props))) {
      errors.push(`${where}: "props" must be an object`);
    }
  });
  return { errors, warnings };
}

// ------------------------------------------------------------- serialization

/**
 * Pretty JSON with every [x, y] pair kept on one line, so the file stays short,
 * readable and diff-friendly for both humans and agents.
 */
const MAP_KEY_ORDER = ['format', 'name', 'notes', 'units', 'bounds', 'background', 'categories', 'features'];
const FEATURE_KEY_ORDER = ['id', 'type', 'name', 'category', 'color', 'notes', 'width', 'directed', 'props', 'points'];

function orderKeys(obj, order) {
  const out = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

export function stringifyMap(doc) {
  const ordered = orderKeys(doc, MAP_KEY_ORDER);
  if (Array.isArray(ordered.features)) {
    ordered.features = ordered.features.map((f) => (f && typeof f === 'object' ? orderKeys(f, FEATURE_KEY_ORDER) : f));
  }
  const json = JSON.stringify(ordered, null, 2);
  return json.replace(/\[\s*(-?[\d.eE+-]+),\s*(-?[\d.eE+-]+)\s*\]/g, '[$1, $2]') + '\n';
}

export function parseMap(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { doc: null, errors: [`invalid JSON: ${e.message}`], warnings: [] };
  }
  return { doc, ...validateMap(doc) };
}

// ----------------------------------------------------------------- geometry

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function bbox(points) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function polygonArea(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return len;
}

/** Area-weighted centroid for polygons, falling back to the vertex average. */
export function centroid(points) {
  if (points.length >= 3) {
    let a = 0,
      cx = 0,
      cy = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      const cross = x1 * y2 - x2 * y1;
      a += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
    if (Math.abs(a) > 1e-9) return [cx / (3 * a), cy / (3 * a)];
  }
  const n = points.length;
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
}

/** Point along a polyline at half its length — where a line's label goes. */
export function polylineMidpoint(points) {
  const half = polylineLength(points) / 2;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    const seg = Math.hypot(x2 - x1, y2 - y1);
    if (acc + seg >= half && seg > 0) {
      const t = (half - acc) / seg;
      return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    acc += seg;
  }
  return points[0];
}

export function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function segmentsIntersect(a, b, c, d) {
  const d1 = orient(c, d, a),
    d2 = orient(c, d, b),
    d3 = orient(a, b, c),
    d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function lineTouchesPolygon(line, poly) {
  if (line.some((p) => pointInPolygon(p, poly))) return true;
  for (let i = 1; i < line.length; i++) {
    for (let j = 0; j < poly.length; j++) {
      if (segmentsIntersect(line[i - 1], line[i], poly[j], poly[(j + 1) % poly.length])) return true;
    }
  }
  return false;
}

function linesIntersect(a, b) {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segmentsIntersect(a[i - 1], a[i], b[j - 1], b[j])) return true;
    }
  }
  return false;
}

/**
 * Spatial relationships between features, keyed by feature id:
 *   within:  areas that fully contain this feature
 *   crosses: areas a line passes through without being fully inside
 *   meets:   other lines a line intersects (e.g. where a road crosses a river)
 */
export function relations(doc) {
  const areas = doc.features.filter((f) => f.type === 'area');
  const lines = doc.features.filter((f) => f.type === 'line');
  const out = {};
  for (const f of doc.features) {
    const within = [];
    const crosses = [];
    const meets = [];
    for (const a of areas) {
      if (a === f) continue;
      if (f.points.every((p) => pointInPolygon(p, a.points))) within.push(a.id);
      else if (f.type === 'line' && lineTouchesPolygon(f.points, a.points)) crosses.push(a.id);
    }
    if (f.type === 'line') {
      for (const l of lines) if (l !== f && linesIntersect(f.points, l.points)) meets.push(l.id);
    }
    out[f.id] = { within, crosses, meets };
  }
  return out;
}

// ---------------------------------------------------------------- description

function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function pt([x, y]) {
  return `(${fmt(x)}, ${fmt(y)})`;
}

/** Plain-text summary of a map, written for agents (and humans) to read quickly. */
export function describeMap(doc) {
  const u = doc.units || 'units';
  const lines = [];
  lines.push(`Map: ${doc.name || '(unnamed)'}`);
  lines.push(
    `Size: ${fmt(doc.bounds.width)} × ${fmt(doc.bounds.height)} ${u}. Origin (0, 0) is the top-left corner; +x is east/right, +y is south/down.`,
  );
  if (doc.background) lines.push(`Background image: ${doc.background.image} (stretched over the full bounds)`);
  if (doc.notes) lines.push(`Notes: ${doc.notes}`);

  const cats = doc.categories || {};
  const counts = {};
  for (const f of doc.features) counts[f.category || '(none)'] = (counts[f.category || '(none)'] || 0) + 1;
  lines.push('');
  lines.push('Categories:');
  for (const [id, c] of Object.entries(cats)) {
    lines.push(`  ${id} ${c.color}${c.description ? ` — ${c.description}` : ''} [${counts[id] || 0} features]`);
  }
  if (counts['(none)']) lines.push(`  (no category) [${counts['(none)']} features]`);

  const rel = relations(doc);
  lines.push('');
  lines.push(`Features (${doc.features.length}, listed bottom to top in draw order):`);
  for (const f of doc.features) {
    const head = [`[${f.type}] ${f.id}`];
    if (f.name) head.push(`"${f.name}"`);
    if (f.category) head.push(`category=${f.category}`);
    if (f.type === 'line' && f.directed) head.push('directed (flows from first point to last)');
    if (f.width) head.push(`width=${f.width} ${u}`);
    lines.push(`- ${head.join(' ')}`);
    const b = bbox(f.points);
    if (f.type === 'area') {
      lines.push(
        `    ${f.points.length} vertices; spans x ${fmt(b.minX)}–${fmt(b.maxX)}, y ${fmt(b.minY)}–${fmt(b.maxY)}; center ${pt(centroid(f.points))}; area ${fmt(polygonArea(f.points))} ${u}²`,
      );
    } else if (f.type === 'line') {
      lines.push(
        `    ${f.points.length} points from ${pt(f.points[0])} to ${pt(f.points[f.points.length - 1])}; length ${fmt(polylineLength(f.points))} ${u}`,
      );
    } else {
      lines.push(`    at ${pt(f.points[0])}`);
    }
    const r = rel[f.id];
    if (r.within.length) lines.push(`    inside: ${r.within.join(', ')}`);
    if (r.crosses.length) lines.push(`    passes through: ${r.crosses.join(', ')}`);
    if (r.meets.length) lines.push(`    intersects lines: ${r.meets.join(', ')}`);
    if (f.props && Object.keys(f.props).length) lines.push(`    props: ${JSON.stringify(f.props)}`);
    if (f.notes) lines.push(`    notes: ${f.notes.replace(/\n/g, '\n           ')}`);
  }
  return lines.join('\n');
}
