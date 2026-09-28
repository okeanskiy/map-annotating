# Map Annotator

A local, 2D, single-level **map annotation tool** for laying out large-scale maps: which areas are
what, where a river flows, where the roads run, what each place should feel like. It is
built so that **AI agents (like Claude) can read and write the same document** you're editing.

It has nothing to do with any particular game engine or modelling tool. The output is a design
document, and whoever or whatever builds the map reads that.

![Example map](docs/example-preview.png)

## Quick start

Requires Node.js 18+. There are no dependencies to install.

```sh
git clone https://github.com/okeanskiy/map-annotating
cd map-annotating
node bin/mapdoc.js serve ~/maps/my-map      # creates the folder if needed
# open http://127.0.0.1:4178
```

Try the example: `npm run example`.

Optionally run `npm link` to get a global `mapdoc` command.

## The map folder

```
my-map/
  map.json        ← the document (single source of truth)
  preview.png     ← rendered image, updated by the editor while it's open
  background.png  ← optional reference image you uploaded to trace over
  AGENTS.md       ← format + workflow guide for agents
  CLAUDE.md       ← points Claude Code at AGENTS.md
```

## Using it with an agent

Open Claude Code (or any agent) **in the map folder**. It picks up `CLAUDE.md` / `AGENTS.md`
and knows the format. Keep the editor open next to it:

- Ask things like _"read the map and tell me what's unclear"_, _"add a lake where the river ends"_,
  or _"split Oakford into three districts"_. The agent edits `map.json` and the editor redraws live.
- Agents can pin questions to the map as red `note` points.
- Undo in the editor (Ctrl+Z) also reverts agent edits.
- If an agent writes an invalid file, the editor pauses and shows the errors instead of overwriting it.

CLI helpers for agents and scripts:

| Command                    |                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `mapdoc describe <folder>` | Text summary: every feature with size, position, notes, and what's inside / crosses what |
| `mapdoc validate <folder>` | Checks `map.json`; exit code 1 on errors                                                 |
| `mapdoc guide`             | Prints the full format + workflow guide ([docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md))     |
| `mapdoc init <folder>`     | New map folder (`--name`, `--width`, `--height`, `--units`)                              |

## Editor basics

- **Tools:** Select `V`, Area `A`, Line `L`, Point `P`. "Draw as" sets the category of new shapes.
- **Draw:** click to add points. Double-click, `Enter` or right-click finishes; `Esc` cancels.
- **Edit:** drag a shape to move it, drag vertices to reshape it, click a midpoint dot to add a vertex,
  and Alt+click a vertex to remove it. Use `Delete` to remove the selected shape.
- **View:** scroll to zoom. Drag empty space, hold Space and drag, or use the middle mouse button to pan. `F` fits the map.
- **Inspector:** name, id, category, notes, color, line width/direction, and free-form properties.
  With nothing selected, it shows map settings: size, units, background image and categories.

Coordinates: `(0, 0)` is the top-left corner, +x is east and +y is south, in whatever `units` you choose.

## Development

```sh
npm test          # unit + server tests (node:test)
```

- `public/`: the editor (plain ES modules + SVG, no build step)
- `public/js/model.js`: document format, validation, geometry and descriptions (shared by browser, server and CLI)
- `src/server.js`: local HTTP server, file watching, live updates over SSE
- `bin/mapdoc.js`: CLI
