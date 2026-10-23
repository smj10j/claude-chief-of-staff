# Snowflake for Chief of Staff (`cos snow`) — optional

Query Snowflake read-only from Claude Code (or the terminal): you authenticate **once** in your browser,
the Snowflake CLI caches the token on disk, and after that Claude can run `snow sql` non-interactively —
no MCP, no per-query browser popup, no password.

Everything here is optional. If you don't use Snowflake, ignore this folder; `cos snow --check` simply
reports it as unavailable.

> **Read-only by convention AND by role.** The runner only accepts `SELECT` / `WITH` / `SHOW` /
> `DESCRIBE` / `EXPLAIN`, and you should point it at a role that can only read, so the database enforces
> it too. Never point this at a write/delete, and **never write query output containing customer/PII
> data into a file that could be committed or shared** — print counts and aggregates, not raw rows.

## Why the CLI (not a Snowflake MCP)

Browser-based SSO running *inside* an MCP server tends to be flaky in an agent session — it hangs on the
browser step and times out. The `snow` CLI moves auth **out of band**: you complete the browser login once
in your own terminal, the connector caches the token, and every later `snow sql` (including the ones
Claude runs for you) reuses it silently.

## Prerequisites

- **Snowflake CLI** — `brew install snowflake-cli` (or `pipx install snowflake-cli`). See step 1.
- **Node.js 22+** — the `cos snow` wrapper (`bin/snow/snow.sh`) sources nvm and runs `node`. Same
  requirement as the task CLI: if `bash bin/cos task list` works, you're set.
- **A Snowflake account and a read-only role granted to you.** Ask whoever administers Snowflake at your
  company for an analyst/read-only role. Without it, auth succeeds but every query fails on permissions.

## Setup (one-time)

Do **steps 1–4 once** on a new machine; after that, `bash bin/cos snow "SELECT ..."` (step 5) just works.
The step 4 browser auth only recurs when the cached token expires (re-run that one line).

Quick verify at any point: `bash bin/cos snow --check` — it probes the CLI and your connection settings
**without running a query**, so it never pops a browser, and it tells you exactly what's missing.

### 1. Install the Snowflake CLI

```bash
brew install snowflake-cli        # or: pipx install snowflake-cli
snow --version
```

If `snow: command not found` afterward, make sure Homebrew's bin directory (e.g. `/opt/homebrew/bin`) is
on your `PATH`.

### 2. Create the connection — write `connections.toml` by hand

Prefer editing the file over `snow connection add`: the wizard defaults to *password* auth, which you
don't want for SSO. Start from the template, replace every `<placeholder>`, and install it:

```bash
mkdir -p ~/.snowflake
cp bin/snow/connections.toml.template ~/.snowflake/connections.toml
# edit ~/.snowflake/connections.toml: connection name, account, user, role, warehouse, database
chmod 600 ~/.snowflake/connections.toml
snow connection list              # must show your connection by name (NOT one named 'connections')
```

> ⚠️ **The section header is `[<your-connection>]`, not `[connections.<your-connection>]`.** In the
> dedicated `~/.snowflake/connections.toml`, connections are top-level tables. With
> `authenticator = "externalbrowser"` there is **no** `password` and **no** `host` line — the browser
> handles auth and `host` derives from `account`. If your company uses key-pair or OAuth auth instead,
> use the matching settings from the Snowflake CLI docs; never store a password in this file.

### 3. Point `cos snow` at the connection

`cos snow` has **no built-in defaults** — it needs to know which connection to use. Either export env vars
(e.g. in your shell profile):

```bash
export COS_SNOW_CONNECTION="<your-connection>"   # required: the [section] name from step 2
export COS_SNOW_ROLE="<read-only-role>"          # optional overrides; when unset, the
export COS_SNOW_WAREHOUSE="<warehouse>"          #   connection's own values from
export COS_SNOW_DATABASE="<database>"            #   connections.toml are used
export COS_SNOW_SCHEMA="<schema>"
```

…or, so it also works for non-interactive runs (scheduled briefings, the desktop app), put the same
settings in a per-instance config file:

```bash
mkdir -p data/files/snowflake
cp bin/snow/config.example.json data/files/snowflake/config.json
# edit: set "connection"; fill or delete role / warehouse / database / schema
```

Precedence: env vars > `config.json` > the connection's values in `connections.toml`. Values still shaped
like `<placeholders>` are ignored. You can keep several connections in `connections.toml` and switch with
`COS_SNOW_CONNECTION=<other> bash bin/cos snow ...`.

### 4. Authenticate (you, once; the browser pops for you)

```bash
snow sql -c <your-connection> -q "SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE();"
```

This opens your SSO login in the browser. Approve it once; the token is cached until it expires (then just
re-run this line). After it succeeds, **Claude can run everything below without a browser.**

### 5. Run a query

```bash
bash bin/cos snow "SELECT CURRENT_USER() AS ME, CURRENT_TIMESTAMP() AS NOW"
bash bin/cos snow --file path/to/query.sql
bash bin/cos snow --json "SELECT ..."     # raw JSON rows instead of a table
bash bin/cos snow --check                 # is Snowflake usable right now? (no query, no browser)
```

`--check` is the "when it's available" probe. It verifies the `snow` CLI is installed, a connection name
is configured, and that connection exists in `connections.toml` — **without running a query**, so it never
risks a browser popup. It exits non-zero and prints what to fix when anything is missing. Token liveness is
only confirmed when you actually run a query — if the cached token has expired, the query fails with an
SSO/session error and you (the human) re-run step 4.

### As a module

Other tooling can `require('../snow/snow.js')`:

```js
const { runSnowQuery, snowAvailability } = require('../snow/snow.js');
if (snowAvailability().available) {
  const rows = runSnowQuery('SELECT COUNT(*) AS N FROM <DB>.<SCHEMA>.<TABLE>');
}
```

`runSnowQuery(sql, { connection, role, warehouse, database, schema })` accepts per-call overrides that win
over env and `config.json`.

## Data dictionary (business term ↔ table/column, self-maintaining)

Warehouse schemas are large and cryptic: event tables with generated names, a concept that lives in an
unexpected column, a filter value nobody remembers. Re-discovering that every session is slow and
error-prone. `cos snow` keeps a growing **semantic dictionary** so mappings, columns, and gotchas learned
once are reused from then on.

- **Mechanism** (`bin/snow/dictionary.js`) is template code — generic, schema-agnostic.
- **Content** lives under `data/files/snowflake/` (`dictionary.json` + `usage-log.jsonl`) — your data,
  version-controlled in your own instance, never part of the template. Nothing ships pre-filled: the
  dictionary starts empty and `dictionary.json` is created the first time you record an entry. Override
  the location with `COS_SNOW_DICT_DIR`.
- It holds **schema metadata only** (table/column names, business mappings, gotchas) — never rows or
  query results.

### Utilize — always look before you spelunk

Before exploring `INFORMATION_SCHEMA` for a business concept, search the dictionary:

```bash
bash bin/cos snow --dict <keywords>      # e.g. --dict monthly active users
bash bin/cos snow --dict                 # summary (counts + how to use)
bash bin/cos snow --dict-list            # all objects + terms, one line each
```

If the concept is known you get the exact table, the column it lives in, and the gotchas — skip the
exploration. If not, explore the live schema, then record what you learned (below).

### Maintain — record what you learn

After confirming a new table/column/term mapping, write it back so the next session starts ahead:

```bash
bash bin/cos snow --dict-add '{"kind":"term","term":"<business term>","maps_to":"<DB>.<SCHEMA>.<TABLE> WHERE <filter>","notes":"...","source":"..."}'
bash bin/cos snow --dict-add '{"kind":"object","name":"<DB>.<SCHEMA>.<TABLE>","grain":"one row per ...","columns":{"<COL>":"desc"},"gotchas":["..."],"source":"..."}'
# Bulk / complex entries (embedded quotes) — pass a JSON file (one entry object, or an array):
bash bin/cos snow --dict-add-file /tmp/new-entries.json
```

Entry shapes:

| kind | required | optional |
| --- | --- | --- |
| `object` (a table/view) | `name` | `aka[]`, `grain`, `domain`, `columns{col: desc}`, `gotchas[]`, `notes`, `source`, `verified` |
| `term` (a business concept) | `term`, `maps_to` (a table or a concrete filter) | `aka[]`, `notes`, `source`, `verified` |

Conventions:

- **Merge, don't duplicate.** `--dict-add` merges by identity (`object.name` / `term.term`,
  case-insensitive): re-adding **enriches** the existing entry (new fields win) instead of creating a
  second one. Adding notes to a known term doesn't need `maps_to` again.
- **Every entry is dated and sourced.** `verified` is stamped with today's date unless you pass one;
  always include a `source` (the query, doc, or person that confirmed it).
- **Prefer concrete, reusable mappings** — exact filter values, the column the concept actually lives in,
  the performance gotcha — over vague pointers.
- **Use `--dict-add-file` for anything with embedded quotes** — shell-quoting large JSON inline is
  error-prone. You can also edit `dictionary.json` directly; it's plain JSON, pretty-printed on every
  write. If the file is ever malformed, `cos snow --dict` stops with an error rather than overwriting it.
- **Advisory, not gospel.** If a query returns zero or odd rows, re-check the live schema and update the
  entry — a stale mapping is a bug to fix, not a fact to trust.

Generic Snowflake gotchas worth recording once you hit them: `INFORMATION_SCHEMA` is
**database-level** — query `<DB>.INFORMATION_SCHEMA.TABLES` / `.COLUMNS` filtered by `TABLE_SCHEMA = '<X>'`
rather than `<DB>.<X>.INFORMATION_SCHEMA`. `ROWS` and `ASOF` are reserved words — don't use them as aliases.
`--json` returns numeric aggregates as **strings** — cast before formatting.

### Automatic enrichment (usage log)

Every successful `cos snow` query appends the tables it touched — names + timestamp only, never SQL
literals or results — to `usage-log.jsonl`, building a frequency / last-seen signal with zero effort. It's
a machine-generated runtime file; keep it out of version control. Disable it with `COS_SNOW_NO_LOG=1`.

## Config reference

| Env var | `config.json` key | Default | Meaning |
| --- | --- | --- | --- |
| `COS_SNOW_CONNECTION` | `connection` | _(none — required)_ | named connection in `~/.snowflake/connections.toml` |
| `COS_SNOW_ROLE` | `role` | the connection's `role` | role to run as (use a read-only one) |
| `COS_SNOW_WAREHOUSE` | `warehouse` | the connection's `warehouse` | warehouse |
| `COS_SNOW_DATABASE` | `database` | the connection's `database` | default database (fully-qualify names anyway) |
| `COS_SNOW_SCHEMA` | `schema` | the connection's `schema` | default schema |
| `COS_SNOW_CONFIG` | — | `data/files/snowflake/config.json` | path to the optional config file |
| `COS_SNOW_DICT_DIR` | — | `data/files/snowflake` | dictionary content dir (`dictionary.json`, `usage-log.jsonl`) |
| `COS_SNOW_NO_LOG` | — | _(unset)_ | set to any value to disable the per-query usage log |

## Troubleshooting

- **`✗ Snowflake not available` from `--check`** → follow the detail it prints: install the CLI (step 1),
  configure a connection name (step 3), or add the connection to `connections.toml` (step 2).
- **`Connection <name> is not configured`** → your `connections.toml` probably used
  `[connections.<name>]`. Change the header to `[<name>]` and re-run `snow connection list`.
- **A browser tries to open when *Claude* runs a query** → the cached token expired; re-run the step 4 auth
  line yourself, then retry.
- **`account not found` / `no active warehouse`** → check `account` (use the full account identifier from
  your Snowflake URL) and `warehouse` in `connections.toml`, or override with `COS_SNOW_WAREHOUSE`.
- **Role / permission error on every query** → the role isn't granted to you yet; ask your Snowflake admin.
- **Zero rows / weird numbers** → a renamed column or flipped sign returns empty or inverted results
  silently. Sanity-check table and column names against the live schema (and fix the dictionary entry)
  before trusting the output.
