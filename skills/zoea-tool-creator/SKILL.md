---
name: zoea-tool-creator
description: Use when the user asks to create, scaffold, or convert a Zoea tool — a small, agent-native CLI registered through a `tools.{toml,yaml,json}` manifest. The skill enforces narrow scope (one or two verbs, not whole APIs), agent-native CLI conventions, and integration with the zoea-tools manifest format.
---

# Zoea Tool Creator

A Zoea tool is **a small purpose-built CLI plus a manifest entry**. The CLI does one or two things well; the manifest teaches Pi how to invoke it. This skill helps you build new tools and convert existing scripts to the same shape.

The agent's most common failure mode here is **scope creep** — wrapping a whole API "just in case." Push back hard. A focused tool ships in an hour and stays maintainable. A "complete" wrapper turns into a side project.

## When this skill applies

- "Create a Zoea tool that …"
- "Add a tool for fetching recent X from Y"
- "Wrap this existing script as a Zoea tool"
- "Convert `<some shell script or one-off>` so an agent can call it"

If the user is asking for full API coverage, broad service wrappers, OpenAPI codegen, or anything that sounds like a competitor to `gh` or the official Sentry CLI — stop and re-read [Step 1: Scope](#step-1-scope-the-tool-narrowly).

## Workflow

Follow these steps in order. Don't skip the scoping step even when the user seems to know what they want — the most common defect is a tool whose scope was never pinned down.

### Step 1: Scope the tool narrowly

Before writing anything, get explicit answers to:

1. **What 1–3 commands or endpoints will the user actually run?** Not "list issues" — `list issues created in the last 7 days, filtered to status=open, in repo X`.
2. **What inputs vary call-to-call?** Those become flags. Everything else is hardcoded or read from env.
3. **What's the output for?** Human reading? Aggregation by another tool? Persisted as an artifact under `.zoea/output/`?
4. **Is there an existing CLI for the underlying service?** If so, the Zoea tool is usually a thin opinionated wrapper around it (e.g. `gh` or `sentry`), not a re-implementation.

Read [scoping.md](scoping.md) for the full interview script. If the user resists narrowing, name the tradeoff plainly: "A broader tool will take 5× longer to build and you'll forget how it works in a month. Pick the verb you need this week."

### Step 2: Decide the implementation language

Match the existing grain of the codebase:

- **Bash + an existing CLI** (`gh`, `sentry`, `jq`, `curl`) — the right default. Most Zoea tools are 30–80 lines of shell.
- **Python via `uv` / `uvx`** — when you need real argument parsing, structured output, or you're calling `zoea_core` for artifact writing.
- **Node** — only when an existing Node CLI does the heavy lifting (e.g. an SDK that's Node-only).

Avoid building a Go binary unless the existing tool already exists in Go. Compile-and-distribute is a high tax for a narrow tool.

### Step 3: Scaffold the tool

Use the `zoea-tool-new` command (installed by `zoea-core`):

```bash
uv run --from /path/to/Zoea/zoea-core zoea-tool-new \
  --name github_recent_activity \
  --description "Fetch recent GitHub issues and PRs for one or more repos" \
  --interpreter bash \
  --manifest .zoea/tools.yaml \
  --input "repo:string:repeatable:Repository in owner/name form" \
  --input "days:integer:default=7:Look back N days" \
  --input "output-dir:string:default=./output:Directory to write reports to"
```

This creates:

- `.zoea/tools/<name>/<name>.{sh,py,…}` with a runnable skeleton (parses flags, emits `--help`, exits with conventional codes).
- A new entry in the target manifest (`.zoea/tools.yaml` by default), wired to the script with the inputs you declared.

If the manifest already contains a tool with the same name, the scaffolder refuses with a clear error rather than overwriting. Pick a different `--name` or remove the existing entry.

After scaffolding, **read the generated script**, fill in the body, and verify it runs:

```bash
bash .zoea/tools/github_recent_activity/github_recent_activity.sh --help
bash .zoea/tools/github_recent_activity/github_recent_activity.sh --repo unbracketed/zoea --days 7
```

### Step 4: Apply agent-native CLI principles

The scaffold gives you the skeleton; you still need to write the body to these standards. Read [principles.md](principles.md) for the full digest, but the table-stakes ones are:

- **Non-interactive by default.** No prompts. If you need confirmation for something destructive, gate it behind `--yes` or `--force`.
- **`--json` for machine output, never `--format=json`.** When stdout is not a TTY, default to JSON.
- **Errors enumerate valid options.** `error: --status must be one of: open, closed, all (got 'pending')`. Not `error: bad status`.
- **Exit codes are typed.** `0` success, `2` usage error, `3` not found, `4` auth failure, `5` upstream error, `7` rate limited.
- **Bounded output.** Default `--limit 20` for any list. Tell the agent how to widen it in the truncation message.
- **Diagnostics to stderr, results to stdout.** Never mix.

### Step 5: Wire artifacts (if the tool produces files)

If the tool writes reports, screenshots, exports, or other files an agent might want to reference later, write them under `${ZOEA_DIR}/output/${ZOEA_RUN_ID}/artifacts/<tool-name>/...` and print the artifact paths as part of the JSON result. Agents discover artifacts by reading these paths back, not by guessing locations.

`ZOEA_DIR`, `ZOEA_RUN_ID`, `ZOEA_SESSION_CWD`, `ZOEA_TOOL_NAME`, and `ZOEA_TOOL_MANIFEST` are exported automatically by the manifest loader — use them, don't hardcode `.zoea/output`.

### Step 6: Verify and document

1. Run the tool directly with realistic inputs.
2. Run it through `pi` (or via `zoea-server`) and confirm the manifest registration works: `/zoea-tools-status` should list your tool with no errors.
3. Add a short usage note to the project's tool docs (or to the tool's own `--help`).

## Converting an existing script

For "I already have this script, make it a Zoea tool," follow [conversion.md](conversion.md). The short version:

1. Identify hardcoded values that need to become flags.
2. Strip interactive prompts; replace with flags or env vars.
3. Add `--help` and `--json`.
4. Wrap exits with the typed exit codes.
5. Drop the script into `.zoea/tools/<name>/`, then add a manifest entry (use `zoea-tool-new --from-existing <path>` — see the conversion playbook).

## Anti-patterns

Reject these even if asked:

- **"Wrap the whole GitHub/Sentry/Stripe/whatever API."** That's not a Zoea tool, that's a CLI project. Pick the 1–3 verbs.
- **`--format json` / `--output-format json`.** Use `--json`.
- **Reading credentials from flags.** Tokens live in env vars (`GITHUB_TOKEN`, `SENTRY_AUTH_TOKEN`, …) so they don't end up in shell history or transcripts.
- **Spinners, progress bars, ANSI colors when stdout isn't a TTY.** Detect and suppress.
- **Hand-rolling an HTTP client when an official CLI exists.** Shell out to `gh`, `sentry`, etc.
- **Writing tools that do more than one thing.** Two narrow tools beat one general one — the agent picks better.
- **Storing state in the user's home dir.** Use `${ZOEA_DIR}` so per-project state stays per-project.

## Reference files

- [principles.md](principles.md) — distilled agent-native CLI principles.
- [scoping.md](scoping.md) — the scoping interview script.
- [conversion.md](conversion.md) — converting an existing script.
- `zoea-tools/README.md` (in this repo) — authoritative manifest format reference. When the manifest format and this skill disagree, the manifest format wins; update the skill.
