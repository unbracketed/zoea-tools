# nanodjango Quirks (and how the scaffolder works around them)

`nanodjango` is excellent for "Django in one file" but optimized for
interactive `nanodjango run app.py` — not the agent-driven CLI flow we
need. These are the specific quirks the generated `cli.py init` papers
over so the agent never has to.

Verified against `nanodjango 0.16.3`. If a future version reshapes any
of this, the scaffolder is small enough to update in one place.

## 1. First-run wants to prompt for a superuser

`nanodjango run app.py` will prompt for an admin username/password the
first time it sees an empty database. That prompt is fatal in agent
contexts.

**Workaround in `cli.py init`:**

- Always call Django's `migrate --run-syncdb` programmatically (not via
  `nanodjango run`). No prompts, ever.
- *After* migrations, idempotently create a superuser if and only if
  `DJANGO_SUPERUSER_USERNAME` and `DJANGO_SUPERUSER_PASSWORD` are both
  set. Email comes from `DJANGO_SUPERUSER_EMAIL` or defaults to empty.
- If those env vars are not set, skip the superuser entirely. The CRUD
  CLI doesn't need one — the admin UI is optional.

This means an agent can call `init` with no env at all and get a
working SQLite store, or set the env vars when it explicitly wants the
admin UI.

## 2. Migration timing

`nanodjango run app.py` makes migrations on the fly when models change.
For CLI-only flows, we want the same behavior on `init`.

**Workaround in `cli.py init`:**

```python
from django.core.management import call_command
call_command("makemigrations", "<feature>", interactive=False, verbosity=0)
call_command("migrate", interactive=False, verbosity=0, run_syncdb=True)
```

Run both, in that order, every time. Both are idempotent.

## 3. Database location

By default nanodjango drops the SQLite file next to `app.py` as
`db.sqlite3`. We want it under `data/<feature>.sqlite3` so it's easy to
find, easy to back up, and easy to gitignore.

**Workaround in `app.py`:**

The scaffolder writes `app = Django(DATABASES={...})` with an explicit
path computed relative to `app.py`:

```python
BASE_DIR = pathlib.Path(__file__).resolve().parent
app = Django(
    DATABASES={
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": str(BASE_DIR / "data" / "<feature>.sqlite3"),
        }
    },
)
```

`init` creates `data/` if it doesn't exist before running migrations.

## 4. Importing the app from the CLI

To use the ORM from `cli.py`, Django must be configured *before* any
model import. nanodjango's `Django(...)` call does that as a side effect.

**Convention in `cli.py`:**

```python
from .app import app, Event   # noqa: F401  -- side effect: configures Django
```

Importing `app` first guarantees settings are bound. The unused
`# noqa: F401` keeps linters happy.

## 5. Single-app `INSTALLED_APPS`

`nanodjango` registers the file as a single Django app named after the
module. The scaffolder names the file `app.py` so the app label is
`app` — short and predictable. `makemigrations app` is the call that
works.

If you rename the file, update the `init` command's `makemigrations`
call to match. The generated code references the app label as a
constant at the top of `cli.py` so this is one edit.

## 6. Async / WSGI

Out of scope for the scaffolder. If a feature ever needs to be served
in production, run `nanodjango convert app.py /path/to/site
--name=<project>` and graduate the feature to a real Django project.
At that point the Zoea CLI tools still work — they only need the
schema, not the runtime mode.
