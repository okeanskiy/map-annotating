import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createMap,
  validateMap,
  parseMap,
  stringifyMap,
  polygonArea,
  polylineLength,
  pointInPolygon,
  relations,
  describeMap,
  mapExtent,
} from '../public/js/model.js';

const example = JSON.parse(fs.readFileSync(new URL('../examples/riverlands/map.json', import.meta.url), 'utf8'));

test('a new map is valid', () => {
  assert.deepEqual(validateMap(createMap()).errors, []);
});

test('the example map is valid', () => {
  const { errors, warnings } = validateMap(example);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('validation catches common agent mistakes', () => {
  const doc = createMap();
  doc.features = [
    {
      id: 'a',
      type: 'area',
      points: [
        [0, 0],
        [1, 1],
      ],
    },
    { id: 'a', type: 'point', points: [[5, 5]] },
    {
      id: 'bad id',
      type: 'line',
      points: [
        [0, 0],
        [1, 1],
      ],
    },
    { id: 'c', type: 'circle', points: [[0, 0]] },
    { id: 'd', type: 'point', points: [[1, 'x']] },
  ];
  const { errors } = validateMap(doc);
  assert.ok(errors.some((e) => e.includes('at least 3')));
  assert.ok(errors.some((e) => e.includes('duplicate id')));
  assert.ok(errors.some((e) => e.includes('"id" must be')));
  assert.ok(errors.some((e) => e.includes('"type" must be')));
  assert.ok(errors.some((e) => e.includes('[x, y]')));
});

test('unknown categories are warnings; points outside the frame are fine', () => {
  const doc = createMap({ width: 100, height: 100 });
  doc.features = [{ id: 'p', type: 'point', category: 'nope', points: [[150, -50]] }];
  const { errors, warnings } = validateMap(doc);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
});

test('image layers are validated and share the id namespace with features', () => {
  const doc = createMap();
  doc.images = [
    { id: 'terrain', file: 'terrain.png', x: -50, y: 0, width: 2000, height: 1500, opacity: 0.8, locked: true },
    { id: 'bad', file: '../secret.png', x: 0, y: 0, width: 0, height: 10 },
  ];
  doc.features = [{ id: 'terrain', type: 'point', points: [[1, 1]] }];
  const { errors } = validateMap(doc);
  assert.ok(errors.some((e) => e.includes('"file" must be a path relative')));
  assert.ok(errors.some((e) => e.includes('"width" must be > 0')));
  assert.ok(errors.some((e) => e.includes('duplicate id')));
  assert.equal(errors.length, 3);
});

test('v1 documents are migrated: background becomes a locked base image', () => {
  const v1 = {
    format: 'map-annotation/1',
    name: 'Old',
    bounds: { width: 400, height: 300 },
    background: { image: 'bg.png', opacity: 0.5 },
    categories: {},
    features: [],
  };
  const { doc, errors } = parseMap(JSON.stringify(v1));
  assert.deepEqual(errors, []);
  assert.equal(doc.format, 'map-annotation/2');
  assert.equal(doc.background, undefined);
  assert.deepEqual(doc.images, [
    { id: 'background', file: 'bg.png', x: 0, y: 0, width: 400, height: 300, opacity: 0.5, locked: true },
  ]);
});

test('mapExtent covers the frame, images and features', () => {
  const doc = createMap({ width: 100, height: 100 });
  doc.images = [{ id: 'i', file: 'a.png', x: -20, y: 10, width: 50, height: 50 }];
  doc.features = [{ id: 'p', type: 'point', points: [[130, -5]] }];
  assert.deepEqual(mapExtent(doc), { minX: -20, minY: -5, maxX: 130, maxY: 100 });
});

test('parseMap reports invalid JSON', () => {
  assert.match(parseMap('{ nope').errors[0], /invalid JSON/);
});

test('stringifyMap round-trips, keeps [x, y] pairs inline and orders keys', () => {
  const doc = createMap();
  doc.features = [
    {
      points: [
        [1, 2],
        [3.5, -4],
      ],
      notes: '',
      type: 'line',
      id: 'l',
    },
  ];
  const text = stringifyMap(doc);
  assert.deepEqual(JSON.parse(text), doc);
  assert.match(text, /\[1, 2\], \[3.5, -4\]|\[1, 2\],\n\s+\[3.5, -4\]/);
  assert.ok(text.indexOf('"id"') < text.indexOf('"type"') && text.indexOf('"notes"') < text.indexOf('"points"'));
});

test('geometry helpers', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.equal(polygonArea(square), 100);
  assert.equal(
    polylineLength([
      [0, 0],
      [3, 4],
    ]),
    5,
  );
  assert.ok(pointInPolygon([5, 5], square));
  assert.ok(!pointInPolygon([15, 5], square));
});

test('relations and describe mention containment and crossings', () => {
  const rel = relations(example);
  assert.deepEqual(rel['ruined-keep'].within, ['north-ridge']);
  assert.ok(rel['silver-river'].crosses.includes('oakford'));
  assert.deepEqual(rel['silver-river'].meets, ['kings-road']);
  const text = describeMap(example);
  assert.match(text, /\[line\] silver-river "Silver River"/);
  assert.match(text, /flows from first point to last/);
});
