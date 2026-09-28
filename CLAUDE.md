# Map Annotator: development notes

- Zero runtime dependencies. The app is plain ES modules served as-is. Keep it that way unless there's a strong reason.
- `public/js/model.js` is shared by the browser, the server and the CLI: no DOM or Node APIs in it.
- The document format is documented for agents in `docs/AGENT_GUIDE.md`. Update that guide (and the
  `format` version, if the change isn't backward compatible) whenever `map.json` changes shape.
- Run `npm test` and `npx prettier --check .` before committing.
