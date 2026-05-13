# Converting an Existing Script to a Zoea Tool

When the user has a working script (bash, Python, ad-hoc one-off) and wants it registered as a Zoea tool, follow this playbook.

The goal is the smallest set of changes that makes the script agent-callable. Don't refactor the body unless you have to.

## Step 0: Read the script

Find:

- Hardcoded paths, repo names, IDs — these usually want to become flags.
- Any place the script reads from stdin or calls `read` — these block agents.
- Any `set -e`, `set -u`, exit-code conventions already in place.
- Where output goes (stdout? files? both?).

## Step 1: Extract inputs

For every value the user might want to vary, decide:

- Flag (`--repo`, `--days`)
- Env var (credentials, host URLs)
- Hardcoded constant (truly fixed for this tool's purpose)

Rule of thumb: if the user has ever copy-pasted the script and changed a value, that value is a flag.

## Step 2: Strip interactivity

Replace any prompts with flags or env. Common patterns:

| Existing | Replacement |
|----------|-------------|
| `read -p "Confirm: " ans` | `--yes` flag |
| `read DAYS` | `--days N` flag |
| `gh auth login` baked in | rely on user's existing `gh` auth, fail fast with exit 4 if absent |
| `aws configure` baked in | same as above |

## Step 3: Add `--help` and flag parsing

For bash, the simplest pattern:

```bash
usage() {
  cat <<'EOF'
Usage: github_recent_activity --repo <owner/name> [--days N] [--json]

Fetch recent issues and PRs for the given repo(s).

Options:
  --repo OWNER/NAME   Repository (repeatable, required)
  --days N            Look-back window in days (default: 7)
  --json              Force JSON output to stdout
  --help              Show this help

Exit codes: 0 ok, 2 usage, 3 not found, 4 auth, 5 upstream, 7 rate limited
EOF
}
```

For Python, use `argparse` with `add_argument(..., action="append")` for repeatable flags.

The scaffolder (`zoea-tool-new`) generates this skeleton automatically. For converting, copy the structure or run the scaffolder with `--from-existing` and let it generate a wrapper that calls your original script.

## Step 4: Wrap output

If the script currently dumps a big table or log to stdout:

1. Move the heavy output to an artifact file under `${ZOEA_DIR}/output/${ZOEA_RUN_ID}/artifacts/${ZOEA_TOOL_NAME}/`.
2. Print a small JSON result with the artifact path.

If the script is small-output already, just make sure stdout is parseable when `--json` is set or stdout is not a TTY.

## Step 5: Wire exit codes

Replace `exit 1` blanket failures with the typed codes (see [principles.md](principles.md#4-typed-exit-codes)). At minimum:

- Bad flag / missing required → `exit 2`
- Auth missing/expired → `exit 4`
- Upstream HTTP failure → `exit 5`

## Step 6: Move it under `.zoea/tools/`

Convention:

```
.zoea/tools/
  <tool_name>/
    <tool_name>.{sh,py,ts}
    README.md       (optional; flag reference and examples)
```

Then add a manifest entry. The scaffolder does this for you when you pass `--from-existing`:

```bash
zoea-tool-new \
  --name github_recent_activity \
  --description "Fetch recent issues and PRs" \
  --from-existing scripts/pull-activity-range.sh \
  --manifest .zoea/tools.yaml \
  --input "repo:string:repeatable" \
  --input "days:integer:default=7"
```

This copies the script into `.zoea/tools/<name>/`, generates the manifest entry, and leaves the original where it is. Verify by running `/zoea-tools-status` inside Pi.

## Step 7: Smoke test

Run the tool standalone, then through Pi. Confirm:

- `--help` works.
- `--json` (or piped stdout) emits parseable JSON.
- Exit codes match the table.
- Artifacts land where the result claims they do.
- No prompts, no spinners, no ANSI when piped.

## When not to convert

Some scripts shouldn't be Zoea tools:

- One-shot fixes that ran once and won't run again.
- Scripts that require human judgment mid-execution.
- Anything that needs a TTY for legitimate reasons (live editor, ncurses UI).

For those, leave them as scripts. Zoea tools are for things an agent will call repeatedly.
