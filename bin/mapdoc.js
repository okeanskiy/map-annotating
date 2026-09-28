#!/usr/bin/env node
// mapdoc: command-line entry point for humans and agents.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap, describeMap } from '../public/js/model.js';
import { ensureProject, startServer } from '../src/server.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(REPO, 'docs', 'AGENT_GUIDE.md');

const USAGE = `mapdoc: 2D map annotation documents for humans and agents

Usage:
  mapdoc serve [folder] [--port 4178]     Open the editor for a map folder (created if missing)
  mapdoc init [folder] [--name N] [--width W] [--height H] [--units U]
                                          Create a new map folder with map.json and agent docs
  mapdoc describe [folder|map.json]       Print a plain-text summary of the map
  mapdoc validate [folder|map.json]       Check map.json; exits 1 on errors
  mapdoc guide                            Print the agent guide (file format + workflow)

[folder] defaults to the current directory.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else positional.push(a);
  }
  return { positional, flags };
}

function mapFile(target = '.') {
  return fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'map.json') : target;
}

function load(target) {
  const file = mapFile(target);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  return { file, ...parseMap(text) };
}

/**
 * Drops agent-facing docs into a map folder so any agent opened there knows the format.
 * An AGENTS.md that is an older copy of our guide is refreshed; one the user wrote is left alone.
 */
function writeAgentDocs(dir) {
  const agents = path.join(dir, 'AGENTS.md');
  const claude = path.join(dir, 'CLAUDE.md');
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const heading = guide.split('\n')[0];
  const current = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : null;
  if (current === null || (current.startsWith(heading) && current !== guide)) fs.writeFileSync(agents, guide);
  if (!fs.existsSync(claude)) fs.writeFileSync(claude, '@AGENTS.md\n');
}

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

switch (cmd) {
  case 'serve': {
    const dir = positional[0] || '.';
    const created = ensureProject(dir);
    writeAgentDocs(dir);
    const port = Number(flags.port ?? process.env.PORT ?? 4178);
    const { url, root } = await startServer({ dir, port });
    console.log(`${created ? 'Created' : 'Editing'} ${path.join(root, 'map.json')}`);
    console.log(`Map Annotator running at ${url}  (Ctrl+C to stop)`);
    break;
  }
  case 'init': {
    const dir = positional[0] || '.';
    const opts = {};
    if (flags.name) opts.name = String(flags.name);
    if (flags.width) opts.width = Number(flags.width);
    if (flags.height) opts.height = Number(flags.height);
    if (flags.units) opts.units = String(flags.units);
    const created = ensureProject(dir, opts);
    writeAgentDocs(dir);
    console.log(created ? `Created ${path.join(dir, 'map.json')}` : `${path.join(dir, 'map.json')} already exists`);
    break;
  }
  case 'describe': {
    const { file, doc, errors } = load(positional[0]);
    if (errors.length) {
      console.error(`${file} is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
      process.exit(1);
    }
    console.log(describeMap(doc));
    break;
  }
  case 'validate': {
    const { file, doc, errors, warnings } = load(positional[0]);
    for (const img of doc?.images || []) {
      if (typeof img.file === 'string' && !fs.existsSync(path.join(path.dirname(file), img.file))) {
        warnings.push(`image "${img.id}": file "${img.file}" not found next to map.json`);
      }
    }
    for (const w of warnings) console.log(`warning: ${w}`);
    for (const e of errors) console.log(`error: ${e}`);
    console.log(errors.length ? `${file}: ${errors.length} error(s)` : `${file}: valid`);
    process.exit(errors.length ? 1 : 0);
    break;
  }
  case 'guide':
    process.stdout.write(fs.readFileSync(GUIDE, 'utf8'));
    break;
  default:
    console.log(USAGE);
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
}
