# zoea-tools

Pi package that discovers declarative tool manifests and registers them as custom tools.

## What it does

- scans configured/default locations for `tools.toml`, `tools.json`, `tools.yaml`, and `tools.yml`
- loads tool definitions from those manifests
- registers each discovered tool with Pi via `pi.registerTool()`
- executes tools through `pi.exec()`

## Default discovery locations

Project-local:

- `.zoea/tools.toml`
- `.zoea/tools.json`
- `.zoea/tools.yaml`
- `.zoea/tools.yml`
- `.zoea/tools/` (recursive scan for the same filenames)
- `.pi/tools.toml`
- `.pi/tools.json`
- `.pi/tools.yaml`
- `.pi/tools.yml`
- `.pi/tools/` (recursive scan for the same filenames)

Global:

- `~/.zoea/tools.toml`
- `~/.zoea/tools.json`
- `~/.zoea/tools.yaml`
- `~/.zoea/tools.yml`
- `~/.zoea/tools/`
- `~/.pi/agent/tools.toml`
- `~/.pi/agent/tools.json`
- `~/.pi/agent/tools.yaml`
- `~/.pi/agent/tools.yml`
- `~/.pi/agent/tools/`

Extra paths can be added with `ZOEA_TOOL_PATHS`, as a colon-separated list of files or directories.

## Optional config files

Project:

- `.zoea/config.json`
- `.pi/zoea-tools.json`

Global:

- `~/.zoea/config.json`
- `~/.pi/agent/zoea-tools.json`

Supported shapes:

```json
{
  "toolPaths": ["./tool-manifests", "./more-tools.yaml"]
}
```

or:

```json
{
  "zoeaTools": {
    "paths": ["./tool-manifests", "./more-tools.yaml"]
  }
}
```

## Install in Pi

From a local checkout:

```bash
pi install ./zoea-tools
```

Or for one-off testing:

```bash
pi -e ./zoea-tools
```

## Manifest format

Top-level shape:

```yaml
version: 1
tools:
  hello_from_python:
    description: Run uvx hello
    command: uvx hello
```

Each tool must define exactly one of:

- `command`: shell command prefix, executed via `bash -lc`
- `entry`: path to a script/executable, relative to the manifest file

Optional fields:

- `interpreter`: `bash`, `sh`, `python`, `node`, `ruby`, or a custom executable name
- `cwd`: working directory for the tool, relative to the manifest file
- `inputs`: typed input definitions
- `tags`: metadata only for now
- `triggers`: metadata only for now
- `timeout_ms`: execution timeout passed to `pi.exec()`
- `env`: environment variables exported before execution

### Inputs

Supported input types:

- `string`
- `integer`
- `number`
- `boolean`

Input fields:

- `type`
- `description`
- `required`
- `default`
- `repeatable`
- `enum` (currently descriptive only)

Example:

```yaml
version: 1
tools:
  github_summary:
    description: Aggregate recent GitHub activity
    entry: ../tools/github-activity/scripts/pull-activity-range.sh
    interpreter: bash
    inputs:
      repo:
        type: string
        description: Repository in owner/name form
        repeatable: true
      days:
        type: integer
        description: Look back N days
        default: 1
      output_dir:
        type: string
        description: Directory to write reports to
        default: ./output
```

### TOML example

```toml
version = 1

[tools.hello_from_python]
description = "Run uvx hello"
command = "uvx hello"

[tools.github_summary]
description = "Aggregate recent GitHub activity"
entry = "../tools/github-activity/scripts/pull-activity-range.sh"
interpreter = "bash"
timeout_ms = 120000

[tools.github_summary.inputs.repo]
type = "string"
description = "Repository in owner/name form"
repeatable = true

[tools.github_summary.inputs.days]
type = "integer"
default = 1
```

## Runtime behavior

- tool names are registered exactly as declared
- repeated inputs become repeated CLI flags (`--repo a --repo b`)
- input names are converted to kebab-case flags (`output_dir` -> `--output-dir`)
- tools run with:
  - `ZOEA_SESSION_CWD=<session cwd>`
  - `ZOEA_DIR=<absolute .zoea or $ZOEA_DIR>`
  - `ZOEA_TOOL_MANIFEST=<manifest path>`
  - `ZOEA_TOOL_NAME=<tool name>`
- stdout/stderr are truncated before being returned to the model

## Debugging

Run this command inside Pi:

```text
/zoea-tools-status
```

It prints:

- scanned paths
- loaded manifests
- loaded tools
- discovery errors

## Limitations

Current version does not yet:

- unregister tools without a Pi reload
- validate `enum` values strictly in the TypeBox schema
