# Scoping Interview

Before scaffolding any tool, walk the user through these questions. Refuse to skip — even if the user pushes back. A misspecified tool wastes more time than the interview takes.

The output of this interview is a **tool spec** that the rest of the workflow consumes.

## Questions

### 1. What service or system does this tool talk to?

Examples: GitHub, Sentry, our internal Postgres, a local script, an SSH host.

If the answer is "many" → the user wants multiple tools, not one. Repeat the interview per service.

### 2. Name the 1–3 specific commands or endpoints.

Bad: "interact with GitHub issues."
Good: "list issues created in the last N days, filtered to status, in a list of repos."

If the user can't list 1–3 concrete things, the tool isn't ready to build. Ask them to come back when they have a real use case.

If they list more than 3, ask them which one they need *this week*. Build that one. The others can become separate tools (or extensions to this one) once the first is in use.

### 3. What inputs vary per call?

These become flags. For each, capture:

- Name (kebab-case at the CLI, snake_case in the manifest).
- Type (`string`, `integer`, `number`, `boolean`).
- Required vs. optional with a default.
- Repeatable? (e.g. `--repo a --repo b`).

Things that don't vary per call (auth tokens, API hosts) are env vars, not flags.

### 4. What's the output shape?

Pick one:

- **Stdout JSON** — small results (under ~50 rows / a few KB). The agent reads it directly.
- **Artifact file + small JSON pointer** — large results. Write the file, print `{"artifact": "<path>"}`.
- **Side effect only** — the tool does something (creates a ticket, sends a message); JSON result confirms what happened with IDs.

If the user can't decide, default to the artifact pattern. It's the cheapest in tokens and works for any size.

### 5. What credentials are needed, and where do they come from?

- Env var name (e.g. `GITHUB_TOKEN`, `SENTRY_AUTH_TOKEN`).
- An existing CLI's keyring (`gh auth status`, `sentry auth status`).
- None (local-only tool).

**Never** accept tokens via flags. They leak into history and transcripts.

### 6. Failure modes — what can go wrong?

For each, decide the exit code:

- Bad input → `2`
- Repo / issue / project not found → `3`
- Token missing or expired → `4`
- Service is down or returns 5xx → `5`
- Rate limited → `7`

The user often hasn't thought about this; walk them through it. Five minutes here saves hours of "why does this tool fail silently."

### 7. Existing CLI to lean on?

If there's an official CLI (`gh`, `sentry`, `aws`, …) that already authenticates and exposes the data — **use it**. The Zoea tool becomes 30 lines of shell that calls the CLI with the right flags and reshapes the output.

Re-implementing an HTTP client is a smell. Ask: "what does the existing CLI not do that we need?"

## Producing the spec

After the interview, restate the spec back to the user as a single block before building:

```
Tool: github_recent_activity
Purpose: Fetch recent issues and PRs for one or more GitHub repos.
Underlying CLI: gh (already authenticated via gh auth)

Inputs:
  --repo (string, repeatable, required) — owner/name
  --days (integer, default 7) — look-back window
  --kind (string, enum: issues|prs|both, default both)
  --output-dir (string, default .zoea/output/<run>/artifacts/github_recent_activity)

Output: writes one JSON file per repo to output-dir; emits {"status": "ok", "files": [...]} on stdout.

Exit codes: 0 ok, 2 bad flag, 3 repo not found, 4 gh not authed, 5 gh upstream error, 7 rate limited.
```

Get explicit user confirmation on the spec before scaffolding. This is the contract.
