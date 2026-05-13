# Generated Feature Layout

Every feature scaffolded by `zoea-feature-new` lives under
`.zoea/features/<feature>/` and looks the same on disk. Knowing this
layout makes it cheap for an agent to inspect, extend, or debug a feature
without re-reading the scaffolder source.

```
.zoea/features/<feature>/
├── app.py             # nanodjango entry point: Django() instance + models
├── cli.py             # Typer CLI: init/add/list/get/update/delete/search
├── pyproject.toml     # uv-managed project; installs <feature>-cli script
├── README.md          # feature-specific bootstrap and usage
├── .gitignore         # ignores data/ by default (sqlite db is local state)
└── data/              # sqlite home; created on first init
    └── <feature>.sqlite3
```

## File responsibilities

### `app.py`

The minimum viable nanodjango app. Holds:

- `app = Django(...)` with `DATABASES` pointed at `data/<feature>.sqlite3`.
- One `Model` per entity, with the fields declared during scaffolding.
- An optional `@app.route("/")` view that returns a JSON list of recent
  rows — useful as a sanity probe but never the primary interface.
- The model is `admin=True` so the Django admin works out of the box if
  the user runs `nanodjango run app.py`.

The model is the source of truth for the schema. If you need to add a
field later, edit the model and run `uv run <feature>-cli init` again —
nanodjango makes a new migration and applies it.

### `cli.py`

A Typer app whose subcommands are the CRUD verbs. Every verb:

- Uses Rich for human output to a TTY; auto-emits JSON when stdout is
  not a TTY or when `--json` is passed.
- Uses typed exit codes (0 ok, 2 usage, 3 not found, 5 db error).
- Bootstraps Django by importing `app` from `app.py` so the ORM is live.
- Reads/writes through the `app.py` model, never raw SQL.

The console-script entry point in `pyproject.toml` is named
`<feature>-cli`, so `uv run <feature>-cli list` works without `python -m`.

### `pyproject.toml`

A small uv-managed project. Pinned dependencies:

- `nanodjango>=0.16,<1`
- `typer>=0.12`
- `rich>=13`

Declares `<feature>-cli = "<feature>.cli:app"` so the Typer app is
importable as a console script.

### `README.md`

Two sections that matter:

1. **Bootstrap** — three commands: `uv sync`, `uv run <feature>-cli init`,
   verify with `uv run <feature>-cli list --json`.
2. **CLI reference** — terse list of subcommands and their main flags.
   Generated from the scaffolding inputs so it stays in sync.

### `data/`

SQLite lives here. Gitignored by default — feature databases are local
state, not source code. If you want the admin UI later, run
`uv run nanodjango run app.py` from this directory and visit
`http://localhost:8000/admin/`.

## How features integrate with the rest of Zoea

- Each CRUD verb is registered as a separate Zoea tool in
  `.zoea/tools.yaml` (e.g. `music_calendar_add`, `music_calendar_list`).
  The agent picks the right tool by name without a dispatcher flag.
- Tools shell out to `uv run --project .zoea/features/<feature>
  <feature>-cli <verb> ...`, so manifest entries don't need to know
  about the feature's Python deps.
- The feature obeys the same `ZOEA_*` env-var contract as a regular
  tool. Artifacts (e.g. exports, reports) belong under
  `${ZOEA_DIR}/output/${ZOEA_RUN_ID}/artifacts/<feature>/`, not inside
  the feature directory.
