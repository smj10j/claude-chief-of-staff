#!/usr/bin/env node
// snow query runner for Chief of Staff. Run a read-only SELECT and print the rows.
//
//   bash bin/cos snow "SELECT CURRENT_USER() AS ME, CURRENT_TIMESTAMP() AS NOW"
//   bash bin/cos snow --file path/to/query.sql
//   bash bin/cos snow --check          # is Snowflake usable right now? (no query, no browser)
//   bash bin/cos snow --json "SELECT ..."   # emit raw JSON rows instead of a table
//   bash bin/cos snow --dict <keywords>     # look up a business term in the data dictionary
//
// Read-only: only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN are allowed (belt-and-suspenders — point the
// connection at a read-only role so the database enforces it too). Requires a one-time human `snow`
// auth (README step 4); after that it runs non-interactively (no browser), so Claude can call it.

const { readFileSync } = require('node:fs');
const { runSnowQuery, snowAvailability, SnowError } = require('./snow.js');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

// --check: report availability and exit. Non-zero exit when unavailable so scripts can gate on it.
if (has('--check')) {
  const status = snowAvailability();
  if (status.available) {
    console.log(`✓ Snowflake available — ${status.detail}`);
    process.exit(0);
  }
  console.log(`✗ Snowflake not available — ${status.detail}`);
  process.exit(1);
}

// --dict / --dict-add / --dict-list: semantic dictionary (consult before exploring schema; record
// what you learn). Handled before the SQL path so these flags never hit the read-only guard.
if (argv.some((a) => a === '--dict' || a.startsWith('--dict-'))) {
  const { runDictCli } = require('./dictionary.js');
  process.exit(runDictCli(argv));
}

// Assemble the SQL from --file or the trailing positional args (excluding recognized flags).
const asJson = has('--json');
const fileArg = opt('--file');
let sql;
if (fileArg !== undefined) {
  if (!fileArg) {
    console.error('error: --file needs a path to a .sql file');
    process.exit(1);
  }
  sql = readFileSync(fileArg, 'utf8');
} else {
  // Drop known flags (and --json has no value; --file was handled above) and join the rest as SQL.
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') continue;
    positional.push(argv[i]);
  }
  sql = positional.join(' ').trim();
}

if (!sql) {
  console.error(
    'usage: cos snow "SELECT ..."   |   cos snow --file query.sql   |   cos snow --check   |   cos snow --dict <keywords>',
  );
  process.exit(1);
}

// Read-only guard: allow only statements whose first keyword is a read verb. Strip leading line/block
// comments and whitespace first. This is a convenience guard; a read-only role is the real control.
function firstKeyword(text) {
  let s = text.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
  s = s.replace(/^\s*(--[^\n]*\n)+/g, ''); // leading line comments
  s = s.replace(/^\s*\(+/, ''); // parenthesized SELECT / CTE
  const m = s.trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}
const READ_VERBS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);
const kw = firstKeyword(sql);
if (!READ_VERBS.has(kw)) {
  console.error(
    `error: refusing to run a non-read statement (starts with '${kw || '?'}'). ` +
      'This runner is read-only — only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN are allowed.',
  );
  process.exit(1);
}

try {
  const rows = runSnowQuery(sql);
  // Automatic dictionary maintenance: record which tables this query touched (names + timestamp only,
  // never SQL literals or results). Fail-safe — logging can never break a query. Disable with COS_SNOW_NO_LOG.
  try {
    const { logUsage, extractObjects } = require('./dictionary.js');
    logUsage(extractObjects(sql), asJson ? 'json' : 'table');
  } catch {
    /* ignore */
  }
  if (asJson) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } else if (rows.length === 0) {
    console.log('(0 rows)');
  } else {
    console.table(rows);
    console.log(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
  }
} catch (err) {
  if (err instanceof SnowError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
