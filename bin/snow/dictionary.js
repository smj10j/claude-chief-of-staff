// Snowflake semantic dictionary for Chief of Staff.
//
// A small, dependency-free engine that maintains a growing map of your business terms ↔ Snowflake
// tables/columns, so Claude doesn't re-discover the same schema every session. Two halves:
//
//   UTILIZE  — `cos snow --dict <keywords>` searches the dictionary before you go spelunking in
//              INFORMATION_SCHEMA. If the term is known, you get the table, columns, and gotchas.
//   MAINTAIN — `cos snow --dict-add '<json>'` records a new mapping; and every successful `cos snow`
//              query auto-appends the tables it touched to a usage log (frequency + last-seen signal).
//
// Mechanism lives here in bin/snow/ (template code, schema-agnostic). CONTENT lives under
// data/files/snowflake/ (user data) so your organization's schema never ends up in the template repo.
// The content files are created on first write — nothing needs to exist up front.

const fs = require('node:fs');
const path = require('node:path');

// Resolve the content dir: env override wins, else <repo>/data/files/snowflake.
function dictDir() {
  if (process.env.COS_SNOW_DICT_DIR) return process.env.COS_SNOW_DICT_DIR;
  return path.resolve(__dirname, '..', '..', 'data', 'files', 'snowflake');
}
function dictPath() {
  return path.join(dictDir(), 'dictionary.json');
}
function usageLogPath() {
  return path.join(dictDir(), 'usage-log.jsonl');
}

const SKELETON = {
  $schema_version: 1,
  updated: null,
  note:
    'Snowflake semantic dictionary — business term ↔ table/column mappings learned by Claude. ' +
    'Consult before exploring INFORMATION_SCHEMA (`cos snow --dict <term>`); record new findings ' +
    '(`cos snow --dict-add`). See bin/snow/README.md → "Data dictionary".',
  objects: [], // [{ name, aka?, grain?, domain?, columns?:{col:desc}, gotchas?:[], notes?, verified, source? }]
  terms: [], //   [{ term, aka?, maps_to, notes?, verified, source? }]
};

const EMPTY_HINT =
  'The dictionary is empty — add entries with --dict-add as you learn the schema ' +
  '(see bin/snow/README.md → "Data dictionary").';

// A missing file is normal (nothing recorded yet) and yields an empty skeleton. A file that exists but
// won't parse is an error — returning the skeleton there would let the next save() wipe it.
function load() {
  let raw;
  try {
    raw = fs.readFileSync(dictPath(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return JSON.parse(JSON.stringify(SKELETON));
    throw err;
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${dictPath()} is not valid JSON (${err.message}) — fix or move it aside, then retry`);
  }
  // Fill any missing top-level keys so callers can rely on them.
  return { ...SKELETON, ...d, objects: d.objects || [], terms: d.terms || [] };
}

function save(d) {
  d.updated = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(dictDir(), { recursive: true });
  fs.writeFileSync(dictPath(), JSON.stringify(d, null, 2) + '\n', 'utf8');
}

const today = () => new Date().toISOString().slice(0, 10);
const isEmpty = (d) => d.objects.length === 0 && d.terms.length === 0;

// Flatten an entry into a lowercase haystack for substring scoring.
function haystack(entry) {
  const parts = [];
  const push = (v) => {
    if (!v) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'object') Object.entries(v).forEach(([k, val]) => { parts.push(k); push(val); });
  };
  push(entry);
  return parts.join('  ').toLowerCase();
}

// Search terms + objects for the given keyword string. Returns { terms:[], objects:[] } ranked by
// number of query tokens matched (substring). Empty query → everything (summary use).
function search(query) {
  const tokens = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const d = load();
  const score = (entry) => {
    if (tokens.length === 0) return 1;
    const h = haystack(entry);
    return tokens.reduce((n, t) => n + (h.includes(t) ? 1 : 0), 0);
  };
  const rank = (arr) =>
    arr
      .map((e) => ({ e, s: score(e) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e);
  return { terms: rank(d.terms), objects: rank(d.objects) };
}

// Merge a new object/term into the dictionary by identity (object.name / term.term, case-insensitive).
// Shallow-merges fields (new values win); stamps `verified` = today if the caller didn't set one.
function upsert(kind, entry) {
  if (kind === 'object' && !entry.name) throw new Error('object entries need a "name"');
  if (kind === 'term' && !entry.term) throw new Error('term entries need a "term"');
  const d = load();
  if (!entry.verified) entry.verified = today();
  if (kind === 'object') {
    const i = d.objects.findIndex((o) => (o.name || '').toLowerCase() === (entry.name || '').toLowerCase());
    if (i >= 0) d.objects[i] = { ...d.objects[i], ...entry };
    else d.objects.push(entry);
  } else if (kind === 'term') {
    const i = d.terms.findIndex((t) => (t.term || '').toLowerCase() === (entry.term || '').toLowerCase());
    if (i >= 0) d.terms[i] = { ...d.terms[i], ...entry };
    else if (!entry.maps_to) throw new Error(`new term '${entry.term}' needs a "maps_to"`);
    else d.terms.push(entry);
  } else {
    throw new Error(`unknown kind '${kind}' (expected 'object' or 'term')`);
  }
  save(d);
  return entry;
}

// Pull fully-qualified-ish table identifiers out of a SQL string (FROM / JOIN targets). Best-effort:
// used only for the usage log, so false positives/negatives are harmless.
function extractObjects(sql) {
  const out = new Set();
  const re = /\b(?:from|join)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*){0,2})/gi;
  let m;
  while ((m = re.exec(sql || '')) !== null) {
    const id = m[1];
    // Skip obvious subquery/CTE/table-function openers.
    if (/^(select|lateral|table|values|unnest)$/i.test(id)) continue;
    out.add(id.toUpperCase());
  }
  return [...out];
}

// Append one line per query to usage-log.jsonl: which objects were touched, when. No SQL text, no
// filter literals, no results — just table names + timestamp, so nothing sensitive is ever logged.
// Fully fail-safe: any error is swallowed so logging can never break a query.
function logUsage(objects, label) {
  try {
    if (process.env.COS_SNOW_NO_LOG) return;
    if (!objects || objects.length === 0) return;
    fs.mkdirSync(dictDir(), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), objects, label: label || null }) + '\n';
    fs.appendFileSync(usageLogPath(), line, 'utf8');
  } catch {
    /* never break a query on logging */
  }
}

// ── CLI (called from query.js when argv contains a --dict* flag) ──────────────────────────────────
function fmtObject(o) {
  const lines = [`● ${o.name}`];
  if (o.aka && o.aka.length) lines.push(`    aka: ${o.aka.join(', ')}`);
  if (o.grain) lines.push(`    grain: ${o.grain}`);
  if (o.domain) lines.push(`    domain: ${o.domain}`);
  if (o.columns) for (const [c, desc] of Object.entries(o.columns)) lines.push(`    · ${c} — ${desc}`);
  if (o.notes) lines.push(`    notes: ${o.notes}`);
  if (o.gotchas && o.gotchas.length) o.gotchas.forEach((g) => lines.push(`    ⚠ ${g}`));
  const meta = [o.verified && `verified ${o.verified}`, o.source && `src: ${o.source}`].filter(Boolean).join(' · ');
  if (meta) lines.push(`    (${meta})`);
  return lines.join('\n');
}
function fmtTerm(t) {
  const lines = [`▸ ${t.term}  →  ${t.maps_to}`];
  if (t.aka && t.aka.length) lines.push(`    aka: ${t.aka.join(', ')}`);
  if (t.notes) lines.push(`    notes: ${t.notes}`);
  const meta = [t.verified && `verified ${t.verified}`, t.source && `src: ${t.source}`].filter(Boolean).join(' · ');
  if (meta) lines.push(`    (${meta})`);
  return lines.join('\n');
}

function runDictCli(argv) {
  try {
    return dictCli(argv);
  } catch (e) {
    console.error(`cos snow dictionary: ${e.message}`);
    return 1;
  }
}

function dictCli(argv) {
  const i = argv.findIndex((a) => a === '--dict' || a.startsWith('--dict-'));
  const flag = argv[i];
  const rest = argv.slice(i + 1).filter((a) => a !== '--json');

  if (flag === '--dict-add-file') {
    // Bulk/complex add from a JSON file — avoids shell-quoting hell for entries with embedded quotes.
    // File may hold a single entry object ({kind, ...}) or an array of them. Each needs a "kind".
    const p = rest[0];
    if (!p) {
      console.error('usage: cos snow --dict-add-file <path-to-json>   (JSON: one {"kind":...} object or an array of them)');
      return 1;
    }
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.error(`--dict-add-file: cannot read/parse ${p} (${e.message})`);
      return 1;
    }
    const entries = Array.isArray(payload) ? payload : [payload];
    let ok = 0;
    for (const raw of entries) {
      const entry = { ...raw };
      const kind = entry.kind;
      delete entry.kind;
      try {
        upsert(kind, entry);
        console.log(`✓ ${kind}: ${entry.name || entry.term}`);
        ok++;
      } catch (e) {
        console.error(`✗ skipped (${e.message}): ${JSON.stringify(raw).slice(0, 80)}`);
      }
    }
    console.log(`recorded ${ok}/${entries.length} → ${dictPath()}`);
    return ok === entries.length ? 0 : 1;
  }

  if (flag === '--dict-add') {
    const jsonStr = rest.join(' ').trim();
    if (!jsonStr) {
      console.error('usage: cos snow --dict-add \'{"kind":"object|term", ...}\'');
      console.error('  object: {"kind":"object","name":"DB.SCHEMA.TABLE","grain":"...","columns":{"COL":"desc"},"gotchas":["..."],"source":"..."}');
      console.error('  term:   {"kind":"term","term":"<business term>","maps_to":"DB.SCHEMA.TABLE WHERE <filter>","notes":"...","source":"..."}');
      return 1;
    }
    let entry;
    try {
      entry = JSON.parse(jsonStr);
    } catch (e) {
      console.error(`--dict-add: invalid JSON (${e.message})`);
      return 1;
    }
    const kind = entry.kind;
    delete entry.kind;
    try {
      upsert(kind, entry);
    } catch (e) {
      console.error(`--dict-add: ${e.message}`);
      return 1;
    }
    console.log(`✓ recorded ${kind}: ${entry.name || entry.term} → ${dictPath()}`);
    return 0;
  }

  if (flag === '--dict-list') {
    const d = load();
    if (isEmpty(d)) {
      console.log(EMPTY_HINT);
      return 0;
    }
    console.log(`Objects (${d.objects.length}):`);
    d.objects.forEach((o) => console.log(`  ${o.name}${o.grain ? ` — ${o.grain}` : ''}`));
    console.log(`\nTerms (${d.terms.length}):`);
    d.terms.forEach((t) => console.log(`  ${t.term} → ${t.maps_to}`));
    return 0;
  }

  // Default: --dict [keywords] → search (or summary when no keywords).
  const q = rest.join(' ').trim();
  const d = load();
  if (!q) {
    console.log('Snowflake dictionary  (' + dictPath() + ')');
    console.log(`  ${d.objects.length} objects · ${d.terms.length} terms · updated ${d.updated || 'never'}`);
    console.log('  search:  cos snow --dict <keywords>        list: cos snow --dict-list');
    console.log('  record:  cos snow --dict-add \'{"kind":"term","term":"...","maps_to":"..."}\'');
    if (isEmpty(d)) console.log(`\n  ${EMPTY_HINT}`);
    return 0;
  }
  if (isEmpty(d)) {
    console.log(EMPTY_HINT);
    console.log(`  e.g. cos snow --dict-add '{"kind":"term","term":"${q}","maps_to":"<DB.SCHEMA.TABLE / filter>","source":"..."}'`);
    return 0;
  }
  const { terms, objects } = search(q);
  if (terms.length === 0 && objects.length === 0) {
    console.log(`No dictionary match for "${q}". Explore the schema, then record what you learn:`);
    console.log(`  cos snow --dict-add '{"kind":"term","term":"${q}","maps_to":"<DB.SCHEMA.TABLE / filter>","source":"..."}'`);
    return 0;
  }
  if (terms.length) {
    console.log(`Terms matching "${q}":`);
    terms.forEach((t) => console.log(fmtTerm(t)));
  }
  if (objects.length) {
    console.log(`${terms.length ? '\n' : ''}Objects matching "${q}":`);
    objects.forEach((o) => console.log(fmtObject(o)));
  }
  return 0;
}

module.exports = { load, save, search, upsert, extractObjects, logUsage, runDictCli, dictPath, dictDir, usageLogPath };
