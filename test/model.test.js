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

test('unknown categories and out-of-bounds points are warnings, not errors', () => {
  const doc = createMap({ width: 100, height: 100 });
  doc.features = [{ id: 'p', type: 'point', category: 'nope', points: [[150, 50]] }];
  const { errors, warnings } = validateMap(doc);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
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
