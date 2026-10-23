// Thin wrapper over the Snowflake CLI (`snow sql`). It reuses the operator's cached SSO session
// (established once via `snow sql -c <connection> -q "SELECT CURRENT_USER()"` — see README), so this runs
// NON-INTERACTIVELY: no MCP, no per-query browser. Read-only by convention (only run SELECTs).
//
// Plain Node (no build step), matching the rest of bin/. `runSnowQuery(sql)` returns parsed row objects;
// `snowAvailability()` answers "is Snowflake usable right now?" WITHOUT risking a browser popup.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Optional per-instance config file (user data, next to the dictionary). Env vars win over it.
function configPath() {
  if (process.env.COS_SNOW_CONFIG) return process.env.COS_SNOW_CONFIG;
  return path.resolve(__dirname, '..', '..', 'data', 'files', 'snowflake', 'config.json');
}

// Values still shaped like template placeholders ("<warehouse>") count as unset.
const isPlaceholder = (v) => typeof v === 'string' && /^<.*>$/.test(v.trim());
const clean = (v) => (typeof v === 'string' && v.trim() && !isPlaceholder(v) ? v.trim() : undefined);

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new SnowError(`cannot read ${configPath()}: ${err.message}`);
  }
}

/** Resolve connection settings: explicit opts > COS_SNOW_* env > config.json. There are no built-in
 *  defaults — `connection` is required; role/warehouse/database/schema are optional and, when unset,
 *  fall back to whatever the named connection in ~/.snowflake/connections.toml declares. */
function resolveConfig(opts = {}) {
  const file = readConfigFile();
  const pick = (key, envVar) => clean(opts[key]) ?? clean(process.env[envVar]) ?? clean(file[key]);
  return {
    connection: pick('connection', 'COS_SNOW_CONNECTION'),
    role: pick('role', 'COS_SNOW_ROLE'),
    warehouse: pick('warehouse', 'COS_SNOW_WAREHOUSE'),
    database: pick('database', 'COS_SNOW_DATABASE'),
    schema: pick('schema', 'COS_SNOW_SCHEMA'),
  };
}

const NOT_CONFIGURED =
  'no connection configured — set COS_SNOW_CONNECTION (or "connection" in ' +
  'data/files/snowflake/config.json) to the name of a connection in ~/.snowflake/connections.toml ' +
  '(see bin/snow/README.md steps 2-3)';

class SnowError extends Error {}

/** Run a single read-only SQL statement and return the parsed rows.
 *  Args are passed via execFileSync (no shell) so SQL text is never shell-interpreted. */
function runSnowQuery(sql, opts = {}) {
  const cfg = resolveConfig(opts);
  if (!cfg.connection) throw new SnowError(`Snowflake not configured: ${NOT_CONFIGURED}`);

  const args = ['sql', '--connection', cfg.connection];
  if (cfg.role) args.push('--role', cfg.role);
  if (cfg.warehouse) args.push('--warehouse', cfg.warehouse);
  if (cfg.database) args.push('--database', cfg.database);
  if (cfg.schema) args.push('--schema', cfg.schema);
  args.push('--format', 'json', '-q', sql);

  let stdout;
  try {
    stdout = execFileSync('snow', args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err || {};
    if (e.code === 'ENOENT') {
      throw new SnowError(
        'Snowflake CLI `snow` not found on PATH. Install it (see bin/snow/README.md step 1) then retry.',
      );
    }
    // Surface the CLI's stderr, which typically explains an expired session (re-auth needed) or a
    // SQL error. If it mentions the browser/SSO, the cached token has expired — re-run the auth query.
    const msg = (e.stderr || e.message || 'unknown error').toString().trim();
    throw new SnowError(`snow sql failed:\n${msg}`);
  }

  return parseSnowJson(stdout);
}

/** `snow sql --format json` returns an array of row objects for a single statement (and an array of
 *  such arrays for multiple statements). Normalize to a flat row list for the last result set. */
function parseSnowJson(out) {
  const trimmed = (out || '').trim();
  if (!trimmed) return [];
  const data = JSON.parse(trimmed);
  if (!Array.isArray(data)) return [];
  if (data.length > 0 && Array.isArray(data[0])) {
    return data[data.length - 1] ?? [];
  }
  return data;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is Snowflake usable *right now*, without risking a browser popup?
 *
 *  Probes three cheap, offline signals:
 *    - `cli`: is the `snow` binary on PATH? (`snow --version`)
 *    - a connection name is configured (env or config.json)
 *    - `connectionConfigured`: is that connection present in ~/.snowflake/connections.toml?
 *      (`snow connection list` reads the toml only — it does NOT authenticate, so no SSO browser.)
 *
 *  It deliberately does NOT run a query (e.g. `SELECT CURRENT_USER()`): that would trigger the SSO
 *  browser if the cached token has expired, which is exactly what we must avoid in an agent session.
 *  Token liveness is only knowable by actually running a query — surfaced as a clear re-auth error there.
 *
 *  Returns: { available, cli, connectionConfigured, connection, detail } */
function snowAvailability(opts = {}) {
  let connection;
  try {
    connection = resolveConfig(opts).connection;
  } catch (err) {
    return { available: false, cli: false, connectionConfigured: false, connection: null, detail: err.message };
  }

  // 1. Is the CLI installed?
  let version;
  try {
    version = execFileSync('snow', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        available: false,
        cli: false,
        connectionConfigured: false,
        connection: connection ?? null,
        detail: 'snow CLI not found on PATH (install: brew install snowflake-cli — see bin/snow/README.md step 1)',
      };
    }
    return {
      available: false,
      cli: false,
      connectionConfigured: false,
      connection: connection ?? null,
      detail: `snow --version failed: ${(err && (err.stderr || err.message)) || 'unknown error'}`,
    };
  }

  // 2. Is a connection name configured at all? No guessing — tell the user what to set.
  if (!connection) {
    return {
      available: false,
      cli: true,
      connectionConfigured: false,
      connection: null,
      detail: `snow ${version} installed, but ${NOT_CONFIGURED}`,
    };
  }

  // 3. Is the named connection in connections.toml? `connection list` reads the toml only (no auth / no browser).
  let configured = false;
  try {
    const raw = execFileSync('snow', ['connection', 'list', '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      const rows = JSON.parse(raw);
      if (Array.isArray(rows)) {
        configured = rows.some((r) =>
          r && typeof r === 'object' &&
          Object.values(r).some((v) => String(v).toLowerCase() === connection.toLowerCase()),
        );
      }
    } catch {
      // Fall back to a substring scan of the raw text if JSON parsing fails.
      configured = new RegExp(`\\b${escapeRegExp(connection)}\\b`, 'i').test(raw);
    }
  } catch {
    configured = false;
  }

  return {
    available: configured, // cli is implied true here (we got a version)
    cli: true,
    connectionConfigured: configured,
    connection,
    detail: configured
      ? `snow ${version} · connection '${connection}' configured (token liveness confirmed on first query)`
      : `snow ${version} installed, but connection '${connection}' is NOT in ~/.snowflake/connections.toml (see bin/snow/README.md step 2)`,
  };
}

module.exports = { runSnowQuery, parseSnowJson, snowAvailability, resolveConfig, configPath, SnowError };
