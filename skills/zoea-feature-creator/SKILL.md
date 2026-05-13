---
name: zoea-feature-creator
description: Use when the user asks to create or scaffold a small focused app ("feature") that backs a Zoea capability — typically a SQLite-backed CRUD store with an agent-callable CLI. The skill generates a nanodjango app + Typer/Rich CLI under `.zoea/features/<name>/` and registers per-verb tools in the project manifest. Sibling of zoea-tool-creator.
---

# Zoea Feature Creator

A **feature** is a small purpose-built app that supports a Zoea capability — usually a SQLite database with a defined schema plus a CRUD-shaped CLI that agents can call. Think "local music events calendar," "lightweight CRM for my consulting clients," "dependency-tracking notes," "deploy log." Not a web product; a data store with verbs.

The agent's most common failure mode: scope creep into "let's also add tagging, history, multi-user…". One feature = one entity model with a small set of related tables. Push back the same way `zoea-tool-creator` does.

## When this skill applies

- "Create a feature for tracking …"
- "Build a small app that stores … and lets the agent add/list/update/delete"
- "I need a SQLite-backed CRUD thing for …"
- "Scaffold a feature like the music calendar example"

If the user wants a real web product, multi-user accounts, or anything beyond CRUD-from-the-CLI — stop. Use a real Django/FastAPI project, not this skill.

## What the skill generates

Stack:
- **[nanodjango](https://docs.nanodjango.dev/)** for the data layer. Single-file Django app: models, optional admin, optional `/` view.
- **[Typer](https://typer.tiangolo.com/) + [Rich](https://rich.readthedocs.io/)** for the CLI. Typed args, rich help, easy `--json` flag, and clean stderr/stdout separation.
- **SQLite** at `.zoea/features/<feature>/data/<feature>.sqlite3`.
- **Per-verb Zoea tools** in `.zoea/tools.yaml` (one tool per CRUD verb).

Layout under `.zoea/features/<feature>/`:

```
app.py              nanodjango Django() instance, models, optional admin/view
cli.py              Typer CLI: init, add, list, get, update, delete, search
pyproject.toml      uv-installable; deps: nanodjango, typer, rich
README.md           one-command bootstrap and usage
data/               sqlite home, gitignored by default
```

## Workflow

### Step 1: Scope the feature

Same discipline as the tool scoper. Pin down before scaffolding:

1. **One sentence**: what does this feature *track*? "Local music events." "Sales prospects." "Deploys to staging."
2. **The primary entity**: name + 5–12 fields max. Each field gets a name, type, required/optional, default. Stop at 12. If you need more, you have two entities — pick the central one and add the rest later.
3. **Status / lifecycle field?** Most CRUD apps benefit from one: `active|cancelled|postponed`, `open|closed`, `draft|published`. If yes, list the values.
4. **CRUD verbs the agent will actually call.** Default set: `init, add, list, get, update, delete, search`. Drop any you won't use; don't add new ones in v1.
5. **Search surface**: which fields does `search <query>` look at? Default to title-like fields and free text.

If the user wants more than one entity (events + venues + bands, say), build the central one first. Add joined entities only after the simple model has been used long enough to feel constrained.

### Step 2: Scaffold

```bash
zoea-feature-new \
  --name music_calendar \
  --description "Local music events calendar" \
  --entity event \
  --field "title:str:required" \
  --field "date:str:required" \
  --field "time:str" \
  --field "venue:str" \
  --field "bands_json:str:default=[]" \
  --field "tags_json:str:default=[]" \
  --field "cover_charge:str" \
  --field "age_restriction:str" \
  --field "description:str" \
  --field "status:str:default=active" \
  --search "title,venue,bands_json,description"
```

Field-spec syntax: `name:type[:modifier...]`. Types: `str`, `int`, `float`, `bool`, `date`, `datetime`. Modifiers: `required`, `default=<value>`. JSON-array fields are stored as `str` columns named `<thing>_json`; the CLI parses/emits them as JSON.

The scaffolder:
- Writes `app.py`, `cli.py`, `pyproject.toml`, `README.md`, `data/` under `.zoea/features/<name>/`.
- Adds one `.zoea/tools.yaml` entry per CRUD verb, named `<feature>_<verb>` (e.g. `music_calendar_add`).
- Refuses to overwrite an existing feature with the same name.

### Step 3: Bootstrap

The scaffolded README has the exact commands; the short version:

```bash
cd .zoea/features/<feature>
uv sync
uv run <feature>-cli init
```

`init` does the work nanodjango would normally do interactively on first `run`: applies migrations, creates the database, and seeds an admin user from `DJANGO_SUPERUSER_USERNAME` / `DJANGO_SUPERUSER_PASSWORD` / `DJANGO_SUPERUSER_EMAIL` if those are set. If they're not set, it skips the superuser (CLI-only flows don't need one). Idempotent — safe to re-run.

If you ever want the admin UI, set the env vars and run `uv run nanodjango run app.py` from the feature directory.

### Step 4: Verify

From the project root:

```bash
# Confirm the manifest entries loaded
pi /zoea-tools-status

# Smoke test
uv run --project .zoea/features/<feature> <feature>-cli add --title "test" ...
uv run --project .zoea/features/<feature> <feature>-cli list --json
```

The same calls run by the agent through the manifest entries should produce the same output.

## Conversion playbook

For "I have an existing CRUD-shaped app, make it a Zoea feature":

1. **Identify the entity model.** Map fields one-to-one. If the existing app uses JSON columns for arrays, keep the same convention (`<thing>_json` in the new app).
2. **Scaffold the feature** with the same field set. Run `init`.
3. **Migrate the data** with a one-off Python script (or `nanodjango manage app.py loaddata`). Don't try to write a generic importer in the skill — it's a one-time job, write 30 lines and move on.
4. **Replace any callers.** The old tool's manifest entry gets removed; the new per-verb tools take its place.
5. **Archive the old app.** Don't delete until the new tools have been used for a couple of sessions.

## Anti-patterns

Refuse these:

- **Multi-entity scaffolds in v1.** One central entity. Add joined ones later.
- **User accounts / auth.** Out of scope. SQLite + a CLI is single-tenant by design.
- **HTTP API endpoints beyond what nanodjango gives you for free.** If the user wants a real API, they want FastAPI, not this.
- **Writing custom migrations in the scaffold.** nanodjango handles `makemigrations` / `migrate` automatically through `manage`.
- **Storing the SQLite file outside `.zoea/features/<feature>/data/`.** Per-feature isolation matters; don't share databases across features.
- **Adding bespoke verbs (`approve`, `archive`, `publish`) in the initial scaffold.** Ship CRUD first; specialize when the need is real.

## Reference files

- [layout.md](layout.md) — exact file layout and what each file does.
- [nanodjango-notes.md](nanodjango-notes.md) — quirks the scaffolder works around (first-run admin prompt, migration timing, db location).
- [zoea-tool-creator/principles.md](../zoea-tool-creator/principles.md) — the CLI generated by this skill follows the same agent-native principles. Read once.
