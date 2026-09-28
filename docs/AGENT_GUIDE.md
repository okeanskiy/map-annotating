# Map annotation document: guide for agents

This folder holds a **map annotation document**: a 2D, single-level, engine-agnostic
design layout for a large map. A human draws and describes areas, routes, rivers,
landmarks and so on in the Map Annotator editor, often on top of reference images
(terrain drawings, sketches, map screenshots). You (the agent) can read it and
**write to it** to propose or record design changes.

It describes _design intent_, not engine data. Nothing here is tied to any game
engine or modelling tool.

## Files

| File | What it is |
| --- | --- |
| `map.json` | **The document, and the only source of truth.** Read it and edit it directly. |
| `preview.png` | A rendered image of everything: images, annotations, labels as `name [id]`, and grid coordinates. Written by the editor while it is open, so it may be stale or missing if the editor is closed. |
| `*.png`, `*.jpg`, … | Image layers referenced from `map.json` → `images[].file`. |

## Workflow

1. **Get an overview:** `mapdoc describe <folder>` prints a plain-text summary: every
   image and feature with its size, position and notes, plus spatial relations
   ("inside", "passes through", "intersects lines"). **Look at `preview.png`**, which
   is the best way to see the reference images the human annotated on. Grid labels
   along its top and left edges are map coordinates.
2. **Edit `map.json` directly** with your normal file editing tools. Make small,
   targeted edits. Don't rewrite the whole file when you only need to change one feature.
3. **Validate:** `mapdoc validate <folder>`. Fix every error before you finish.
   Warnings are advisory.
4. If the editor is open, it picks up your change within about 250 ms and redraws
   live, and it refreshes `preview.png` about a second later. If the file is invalid,
   the editor pauses and shows your errors to the human until you fix them, so always validate.

If `mapdoc` isn't on the PATH, run `node <map-annotator-repo>/bin/mapdoc.js …`.

## Coordinate system

- 2D, single level. Units are whatever `units` says (e.g. `"m"`); they are only a label.
- **+x points east (right)** and **+y points south (down)**, like image coordinates. North is up.
- The canvas is **unbounded**: coordinates may be negative or larger than the frame.
- `bounds` is the **map frame**, the rectangle from `(0, 0)` to `(width, height)` marking the
  intended play area. Keep content inside it unless there's a reason not to.
- Coordinates are plain numbers. Whole numbers are fine for large maps.
- To locate something you see in an image layer, map pixel positions to world
  coordinates with the image's rectangle: `worldX = x + px / imagePixelWidth * width`, and the same for y.

## Format (`"format": "map-annotation/2"`)

<!-- prettier-ignore -->
```jsonc
{
  "format": "map-annotation/2",       // required, exactly this string
  "name": "Riverlands",
  "notes": "Overall vision for the map, style, constraints…",
  "units": "m",
  "bounds": { "width": 2000, "height": 1500 },   // the map frame
  "images": [                          // reference layers, always drawn beneath all features (first = bottom)
    {
      "id": "terrain-sketch",          // unique across images AND features
      "name": "Hand-drawn terrain",
      "file": "terrain-sketch.png",    // path relative to this folder
      "x": 0, "y": 0,                  // world position of the image's top-left corner
      "width": 2000, "height": 1500,   // world size it is stretched to
      "opacity": 0.8,                  // optional, 0..1 (default 1)
      "locked": true,                  // optional: can't be moved or selected in the editor
      "notes": "Coastline is accurate; hills are rough."
    }
  ],
  "categories": {                      // id -> style + meaning
    "water": { "color": "#3b82f6", "description": "Rivers, lakes, coastlines" }
  },
  "features": [                        // draw order: later features are drawn on top
    {
      "id": "silver-river",            // required, unique, stable; [A-Za-z0-9][A-Za-z0-9_.-]*
      "type": "line",                  // required: "area" | "line" | "point"
      "name": "Silver River",          // human-readable label
      "category": "water",             // key into "categories"
      "color": "#1d4ed8",              // optional override of the category color
      "notes": "Wide and slow. Fordable only at the shallows.",
      "width": 30,                     // lines only, optional: real width in map units
      "directed": true,                // lines only, optional: flows from the first point to the last
      "props": { "depth": "shallow" }, // optional free-form structured attributes
      "points": [[120, 0], [340, 420], [610, 780]]
    }
  ]
}
```

Geometry per type:

- **area**: a polygon, at least 3 points. Don't repeat the first point at the end; the polygon closes itself.
- **line**: a polyline, at least 2 points (rivers, roads, walls, borders, sight lines, routes).
  Set `directed: true` when order matters (river flow, one-way path, player progression).
- **point**: exactly 1 point (landmarks, spawns, objectives, questions pinned to a spot).

Older `map-annotation/1` files (with a single `"background"` image) are upgraded
automatically when read: the background becomes a locked image covering the frame.

## How to write good edits

- **Keep ids stable.** Humans and other agents refer to features by id. Don't rename
  or recycle ids unless asked. New ids should be meaningful slugs
  (`north-gate`, `market-district`), not `area-7`.
- **Put intent in `notes`.** Write in plain language: what the place is, how it should feel,
  how players use it, and hard constraints. Use `props` for short structured facts
  (`"danger": 3`, `"biome": "marsh"`) that you or others may filter on.
- **Trace what's in the images.** When the human asks you to annotate something visible in
  an image layer (a coastline, a road), use `preview.png` and the image's rectangle to
  place points accurately.
- **Change only what you were asked to.** Leave other features, images, the order of the
  `features` and `images` arrays (draw order), and the formatting alone. Don't move,
  resize or delete images unless asked.
- **Use existing categories** where they fit. Add a new category (with a color and
  a description) only when nothing fits.
- **Size things to the map.** Check `bounds`, `units`, the images and nearby features
  (`mapdoc describe`), so that new shapes are plausible in scale and position.
- **Ask on the map.** If something is ambiguous, don't guess silently. Add a
  `point` with `"category": "note"` at the relevant spot, with a `notes` question
  and `"props": { "author": "agent" }`. The human will see it pinned on the map.
- **Mark what you add.** Put `"props": { "author": "agent" }` on features you create,
  unless the human prefers otherwise, so they can review your additions.
- **Keep the formatting.** Use a 2-space indent and write each `[x, y]` pair inline, as the
  editor does. The editor re-formats the file on its next save anyway.

## Example: adding a lake the river flows into

<!-- prettier-ignore -->
```json
{
  "id": "mirror-lake",
  "type": "area",
  "name": "Mirror Lake",
  "category": "water",
  "notes": "Calm, deep lake at the river's end. Visible from the northern ridge.",
  "props": { "author": "agent" },
  "points": [[560, 760], [700, 740], [760, 830], [690, 910], [570, 880]]
}
```

Then extend `silver-river`'s `points` so that its last point lies inside the lake,
and run `mapdoc validate`.
