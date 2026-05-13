# Agent-Native CLI Principles (digest)

A condensed, opinionated version of the principles from Trevin Chow's "10 Principles for Agent-Native CLIs" and the cli-printing-press exit-code conventions, adapted for the narrow-scope Zoea tool case.

The full ten-principle taxonomy assumes you're shipping a broad CLI (think `gh`, `wrangler`). For a Zoea tool that does one or two things, only a subset really matters. They are split below into **table stakes** (must) and **nice to have** (should, when relevant).

## Table stakes

### 1. Non-interactive

Agents cannot answer prompts. Commands must run to completion without TTY input.

- No `read`, no `prompt`, no `confirm`. Replace with flags.
- For destructive operations, gate behind `--yes` or `--force`. Default is "do nothing destructive."
- Detect TTY: `if [ -t 0 ]; then ...` — only enable interactive paths when explicitly attached.

### 2. Structured output

- Use `--json` for machine output. Never `--format=json` or `--output-format json`. One flag, one name, everywhere.
- When stdout is not a TTY (`! [ -t 1 ]`), default to JSON automatically. The agent gets parseable output without remembering a flag.
- Diagnostics, progress, debug — all to **stderr**. Stdout is for the result, nothing else.
- Suppress ANSI escapes when not on a TTY.

### 3. Errors that teach

When you reject input, name the valid options in the error itself. Don't make the agent grep `--help`.

```
error: --status must be one of: open, closed, all (got 'pending')
```

Not:

```
error: invalid status
```

For unknown flags, suggest the closest match if obvious. Skip clever fuzzy-matching for narrow tools — just list the known flags.

### 4. Typed exit codes

The exit code is the cheapest signal an agent can read. Use these consistently:

| Code | Meaning |
|------|---------|
| `0`  | success |
| `1`  | generic failure (avoid when a specific code fits) |
| `2`  | usage error — bad flag, missing required input |
| `3`  | not found — resource doesn't exist |
| `4`  | auth failure — missing or invalid credentials |
| `5`  | upstream / API error — network, 5xx |
| `7`  | rate limited |

Document exit codes in `--help`. Agents check `$?` before parsing output.

### 5. Bounded output

- Lists default to a small limit (start at 20). Make it tunable via `--limit`.
- When you truncate, **say so on stderr** and tell the agent how to widen: `note: showing 20 of ~140 results; pass --limit 200 to see more`.
- Avoid emitting megabytes of JSON to stdout. Write to an artifact and print the path.

## Nice to have

### 6. Idempotency for create operations

If your tool creates resources, accept a natural key or idempotency token so retries don't duplicate. For narrow read-only tools, ignore this principle.

### 7. `--dry-run` for mutations

Any tool that writes (to a service or to disk in a destructive way) should support `--dry-run` that prints what *would* happen. Cheap to add, expensive to omit.

### 8. Profiles / config files

For tools called repeatedly with the same flags, support a config file or env-var defaults. For one-off tools, don't bother — the manifest's `inputs` defaults cover it.

### 9. Async with `--wait`

If the underlying API is async (job IDs, polling), expose `--wait` that blocks until done with sensible backoff. Don't make the agent write its own poll loop.

### 10. Schema introspection (`--schema` or `agent-context`)

A machine-readable description of the CLI's flags and enums. **Skip for narrow Zoea tools** — the manifest already declares the schema. This principle exists for tools shipped as standalone CLIs, not manifest-registered tools.

## Zoea-specific guidance

### Use `ZOEA_*` env vars

The manifest loader exports these into your tool's environment:

- `ZOEA_SESSION_CWD` — the project the agent is operating in. Resolve any other relative paths against this, not `$PWD`.
- `ZOEA_DIR` — the `.zoea/` directory for the session, **always absolute**. The loader resolves it against `ZOEA_SESSION_CWD` before exporting, so tools never have to.
- `ZOEA_RUN_ID` — the current run identifier; use this when creating artifact paths.
- `ZOEA_TOOL_NAME`, `ZOEA_TOOL_MANIFEST` — your own name and the manifest you came from. Useful for self-locating helpers.

If you're testing a tool standalone (no Pi loader), you can simulate the loader's behavior with the canonical fallback:

```bash
ZSESSION_CWD="${ZOEA_SESSION_CWD:-$PWD}"
ZDIR="${ZOEA_DIR:-${ZSESSION_CWD}/.zoea}"
```

This mirrors what the loader exports and keeps the tool runnable from a shell.

### Artifact paths

Write artifacts to `${ZOEA_DIR}/output/${ZOEA_RUN_ID}/artifacts/${ZOEA_TOOL_NAME}/...`. Print artifact paths as part of the JSON result — they're absolute, so the agent (or downstream tools) can read them back regardless of cwd.

### Don't pollute stdout when an artifact exists

If your tool produces a 200-row table, write it as an artifact and emit a small JSON result with the path:

```json
{"status": "ok", "rows": 217, "artifact": ".zoea/output/r_42/artifacts/github_recent_activity/issues.json"}
```

This keeps token costs bounded and gives the agent a stable reference for follow-up work.

### Token budgets matter

Every byte your tool prints is a token the agent pays for. Default to terse. The user can ask for `--verbose` if they want more.
