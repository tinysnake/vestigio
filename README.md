# vestigio

Layered memory for coding agents in [pi](https://github.com/earendil-works/pi). Findings a session produces are stored with their sources, recalled in later sessions, and marked stale when new evidence contradicts them. Every block vestigio injects names a source you can check.

## Requirements

- Node 22.5 or newer. Built-in `node:sqlite` provides FTS5, so there is no database dependency.
- pnpm.
- pi 1.5.2, the version this repository is pinned to and tested against. The range is frozen in [docs/contracts.md](docs/contracts.md).

## Install

From the repository root:

```sh
pnpm install
node scripts/deploy.mjs --model-base-url http://127.0.0.1:11434/v1 --model-id deepseek-v4.1-flash
```

Then restart pi.

`deploy.mjs` runs `pnpm install --frozen-lockfile`, writes `~/.vestigio/config.json` while keeping keys you already set, installs the extension with `pi install packages/pi-extension` and confirms it landed in the pi settings, and links the `vestigio` command into `/usr/local/bin` or `~/.local/bin`. Each step reports `ok`, `skip`, `warn` or `FAIL`. Add `--dry-run` to print the plan without changing anything. `--config`, `--pi-settings` and `--bin-dir` point the script at another layout. `--skip-install` and `--skip-link` drop a step.

`--model-base-url` and `--model-id` are optional, but a memory saved without a model has no navigation text and cannot be found later. Staleness detection and cold-search recovery also stay off. Search, read and save still run.

### Check the install

```sh
node scripts/daemon-smoke.mjs
```

The script creates a temporary store, proves `search` starts the daemon, and proves `stop` removes the endpoint file. A pass ends with `daemon smoke passed: <store>` and exit code 0.

### Try it without installing

`pi -e` loads the extension for one run and caches the file under `~/.pi/agent/tmp/extensions/`. It is not an install, and it does not add the extension to the pi settings.

```sh
VESTIGIO_STORE=$HOME/.vestigio/store.sqlite \
VESTIGIO_MODEL_BASE_URL=http://127.0.0.1:11434/v1 \
VESTIGIO_MODEL_ID=deepseek-v4.1-flash \
pi -e packages/pi-extension
```

## Configure

The extension, the CLI, the daemon and the MCP adapter all read `~/.vestigio/config.json`. Precedence runs from a command-line flag, to an environment variable, to the file, to the built-in default.

```json
{
  "version": 1,
  "store": "~/.vestigio/store.sqlite",
  "model": { "base_url": "http://127.0.0.1:11434/v1", "id": "deepseek-v4.1-flash" },
  "logging": { "activity": false }
}
```

`store` is the only required setting. Without it the extension stays inert. `VESTIGIO_STORE` sets it from the environment and `VESTIGIO_CONFIG` points at a different file. See [docs/configuration.md](docs/configuration.md) for `retrieval`, `history`, `logging`, per-agent models and every environment variable.

## Use

Inside pi, the extension adds a memory reminder to the system prompt and registers six tools.

| Tool | Purpose |
| --- | --- |
| `memory_search` | Search recorded memories and indexed past sessions. |
| `memory_resolve` | Answer a recall question from the layered memory. |
| `memory_read` | Read one memory with its freshness evidence. |
| `memory_request_write` | Save a durable memory from operator words or entry ids. |
| `memory_request_status` | Read a save request's status. |
| `memory_mark_stale` | Report a later effective change against a memory. |

Use `/vestigio-log on` to show an activity panel above the editor with what memory did that session, `off` to hide it, and `clear` to empty it. The choice persists in the config file. The panel is not drawn in print mode or JSON mode.

The `vestigio` command reads the same store from a shell: `search`, `read`, `probe`, `resolve`, `projects`, and `stop` for the daemon.

## Docs

- [docs/configuration.md](docs/configuration.md): every setting, per-agent models and environment variables.
- [docs/operating.md](docs/operating.md): daemon lifecycle, activity panel, uninstall.
- [docs/development.md](docs/development.md): repository layout, tests and the evaluation harnesses.
- [docs/contracts.md](docs/contracts.md): frozen boundary shapes and the compatibility range.
- [.agents/skills/verify-vestigio/](.agents/skills/verify-vestigio/): scripted verification of runtime behavior.
