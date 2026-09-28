# Map annotation document: guide for agents

This folder holds a **map annotation document**: a 2D, single-level, engine-agnostic
design layout for a large map. A human draws and describes areas, routes, rivers,
landmarks and so on in the Map Annotator editor, and you (the agent) can read it
and **write to it** to propose or record design changes.

It describes _design intent_, not engine data. Nothing here is tied to any game
engine or modelling tool.

## Files

| File           | What it is                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map.json`     | **The document, and the only source of truth.** Read it and edit it directly.                                                                                              |
| `preview.png`  | A rendered image of the map (labels show `name [id]` and grid coordinates). Written by the editor while it is open, so it may be stale or missing if the editor is closed. |
| `background.*` | Optional reference image the human traced over, stretched across the map bounds.                                                                                           |

## Workflow

1. **Get an overview:** `mapdoc describe <folder>` prints a plain-text summary: every
   feature with its size, position and notes, plus spatial relations ("inside",
   "passes through"). Look at `preview.png` too if it exists.
2. **Edit `map.json` directly** with your normal file editing tools. Make small,
   targeted edits. Don't rewrite the whole file when you only need to change one feature.
3. **Validate:** `mapdoc validate <folder>`. Fix every error before you finish.
   Warnings are advisory.
4. If the editor is open, it picks up your change within about 250 ms and redraws
   live. If the file is invalid, the editor pauses and shows your errors to the human
   until you fix them, so always validate.

If `mapdoc` isn't on the PATH, run `node <map-annotator-repo>/bin/mapdoc.js …`.

## Coordinate system

- 2D, single level. Units are whatever `units` says (e.g. `"m"`); they are only a label.
- `(0, 0)` is the **top-left** corner of the map. **+x points east (right)** and
  **+y points south (down)**, like image coordinates. North is up.
- The map spans `0..bounds.width` on x and `0..bounds.height` on y. Keep points inside it.
- Coordinates are plain numbers. Whole numbers are fine for large maps.

## Format (`"format": "map-annotation/1"`)

```jsonc
{
  "format": "map-annotation/1", // required, exactly this string
  "name": "Riverlands",
  "notes": "Overall vision for the map, style, constraints…",
  "units": "m",
  "bounds": { "width": 2000, "height": 1500 },
  "background": { "image": "background.png", "opacity": 0.8 }, // or null
  "categories": {
    // id -> style + meaning
    "water": { "color": "#3b82f6", "description": "Rivers, lakes, coastlines" },
  },
  "features": [
    // draw order: later features are drawn on top
    {
      "id": "silver-river", // required, unique, stable; [A-Za-z0-9][A-Za-z0-9_.-]*
      "type": "line", // required: "area" | "line" | "point"
      "name": "Silver River", // human-readable label
      "category": "water", // key into "categories"
      "color": "#1d4ed8", // optional override of the category color
      "notes": "Wide and slow. Fordable only at the shallows.",
      "width": 30, // lines only, optional: real width in map units
      "directed": true, // lines only, optional: flows from the first point to the last
      "props": { "depth": "shallow" }, // optional free-form structured attributes
      "points": [
        [120, 0],
        [340, 420],
        [610, 780],
      ],
    },
  ],
}
```

Geometry per type:

- **area**: a polygon, at least 3 points. Don't repeat the first point at the end; the polygon closes itself.
- **line**: a polyline, at least 2 points (rivers, roads, walls, borders, sight lines, routes).
  Set `directed: true` when order matters (river flow, one-way path, player progression).
- **point**: exactly 1 point (landmarks, spawns, objectives, questions pinned to a spot).

## How to write good edits

- **Keep ids stable.** Humans and other agents refer to features by id. Don't rename
  or recycle ids unless asked. New ids should be meaningful slugs
  (`north-gate`, `market-district`), not `area-7`.
- **Put intent in `notes`.** Write in plain language: what the place is, how it should feel,
  how players use it, and hard constraints. Use `props` for short structured facts
  (`"danger": 3`, `"biome": "marsh"`) that you or others may filter on.
- **Change only what you were asked to.** Leave other features, the order of the
  `features` array (draw order), and the formatting alone.
- **Use existing categories** where they fit. Add a new category (with a color and
  a description) only when nothing fits.
- **Size things to the map.** Check `bounds` and `units`, and nearby features
  (`mapdoc describe`), so that new shapes are plausible in scale and position.
- **Ask on the map.** If something is ambiguous, don't guess silently. Add a
  `point` with `"category": "note"` at the relevant spot, with a `notes` question
  and `"props": { "author": "agent" }`. The human will see it pinned on the map.
- **Mark what you add.** Put `"props": { "author": "agent" }` on features you create,
  unless the human prefers otherwise, so they can review your additions.
- **Keep the formatting.** Use a 2-space indent and write each `[x, y]` pair inline, as the
  editor does. The editor re-formats the file on its next save anyway.

## Example: adding a lake the river flows into

```json
{
  "id": "mirror-lake",
  "type": "area",
  "name": "Mirror Lake",
  "category": "water",
  "notes": "Calm, deep lake at the river's end. Visible from the northern ridge.",
  "props": { "author": "agent" },
  "points": [
    [560, 760],
    [700, 740],
    [760, 830],
    [690, 910],
    [570, 880]
  ]
}
```

Then extend `silver-river`'s `points` so that its last point lies inside the lake,
and run `mapdoc validate`.
