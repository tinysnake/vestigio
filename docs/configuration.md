# Configuration

The pi extension, the CLI, the daemon and the MCP adapter read the same file and the same environment variables. This page is the full reference.

## Where the file is

The default path is `~/.vestigio/config.json`. `VESTIGIO_CONFIG` names a different file. Every consumer reads the file before it reads its own options, so one file configures all four.

When the file names a relative path, the reader resolves it against the directory that holds the config file. When a value starts with `~/`, the reader expands it to your home directory.

The activity panel writes its on/off state back to this file. If `VESTIGIO_CONFIG` names a file that does not exist, the panel does not create it.

## Precedence

From highest to lowest:

1. A command-line flag, such as `--db`.
2. An environment variable, such as `VESTIGIO_STORE`.
3. The config file.
4. The built-in default.

A variable that is already set stays set. The file only fills variables that are unset or empty.

## Full example

```json
{
  "version": 1,
  "store": "~/.vestigio/store.sqlite",
  "model": {
    "base_url": "http://127.0.0.1:11434/v1",
    "id": "auto/deepseek-v4.1-flash",
    "thinking": "low",
    "agents": {
      "detector": { "thinking": "off" },
      "resolver": { "id": "auto/deepseek-v4.1-flash" }
    }
  },
  "retrieval": {
    "budget_bytes": 4096,
    "max_memories": 3,
    "min_score": 1,
    "pool_capacity": 32,
    "timeout_ms": 1000
  },
  "history": {
    "obelisk_home": "~/.obelisk",
    "obelisk_cli": "obelisk"
  },
  "logging": {
    "decision_log": null,
    "activity": false
  }
}
```

An unknown key at any level is an error, not a warning. `version` must be `1`.

## Keys

### `version`

Optional. The only accepted value is `1`.

### `store`

The SQLite file that holds the memory. No built-in default. Give it here, or with `VESTIGIO_STORE`, or with `--db` on a CLI call. `VESTIGIO_DB` is accepted as an alias by the CLI and the MCP adapter.

### `model`

The OpenAI-compatible endpoint vestigio uses for its own calls. These are separate from the provider that serves your pi session.

| Key | Meaning |
| --- | --- |
| `base_url` | Endpoint root, such as `http://127.0.0.1:11434/v1`. |
| `id` | Model id sent in the request body. |
| `api_key` | Bearer token. Prefer `VESTIGIO_MODEL_API_KEY`, and keep a key out of a file you may commit. |
| `thinking` | One of `off`, `low`, `medium`, `high`. `off` sends no `reasoning_effort`. |
| `agents` | Per-agent overrides, described below. |

Without `base_url` the model port is never created. A memory saved without a model has no navigation text and cannot be found by a later search, and the staleness detector and the cold-search recovery both stay off.

### `retrieval`

Controls how much memory the extension injects and how it selects it.

| Key | Default | Meaning |
| --- | --- | --- |
| `budget_bytes` | `4096` | Byte ceiling for the block appended to the user message. |
| `max_memories` | `3` | Most memories in one injected block. |
| `min_score` | `1` | Lowest match score that still counts as a hit. |
| `pool_capacity` | `32` | Candidates kept in the match pool. |
| `timeout_ms` | `1000` | Match deadline. A timeout injects nothing. |

### `history`

The Obelisk index that backs the session-history layer.

| Key | Meaning |
| --- | --- |
| `obelisk_home` | Directory of the history index. Defaults to the operator's own Obelisk home. Use a scratch directory for any run that must not touch real history. |
| `obelisk_cli` | Obelisk executable name or path. |

### `logging`

| Key | Default | Meaning |
| --- | --- | --- |
| `decision_log` | none | Path to a JSONL file. Each retrieval decision is appended there. |
| `activity` | `false` | Whether the activity panel starts visible. `/vestigio-log on` and `off` write this key. |

## Per-agent models

Four internal agents call the model. Each accepts an `id` and a `thinking` override under `model.agents`.

| Agent | Work |
| --- | --- |
| `extraction` | Split a turn into candidate memories worth storing. |
| `detector` | Decide whether the turn contradicts a stored memory. |
| `nav` | Write the navigation text a saved memory is found by. |
| `resolver` | Walk the memory layers to answer a recall question. |

The environment form is `VESTIGIO_MODEL_<AGENT>_ID` and `VESTIGIO_MODEL_<AGENT>_THINKING`, for example `VESTIGIO_MODEL_DETECTOR_THINKING=off`.

## Environment variables

| Variable | Sets |
| --- | --- |
| `VESTIGIO_CONFIG` | Path to the config file. |
| `VESTIGIO_STORE` | `store`. |
| `VESTIGIO_MODEL_BASE_URL` | `model.base_url`. |
| `VESTIGIO_MODEL_ID` | `model.id`. |
| `VESTIGIO_MODEL_API_KEY` | `model.api_key`. |
| `VESTIGIO_MODEL_THINKING` | `model.thinking`. |
| `VESTIGIO_MODEL_<AGENT>_ID` | `model.agents.<agent>.id`. |
| `VESTIGIO_MODEL_<AGENT>_THINKING` | `model.agents.<agent>.thinking`. |
| `VESTIGIO_INJECTION_BUDGET_BYTES` | `retrieval.budget_bytes`. |
| `VESTIGIO_MAX_MEMORIES` | `retrieval.max_memories`. |
| `VESTIGIO_MIN_SCORE` | `retrieval.min_score`. |
| `VESTIGIO_POOL_CAPACITY` | `retrieval.pool_capacity`. |
| `VESTIGIO_MATCH_TIMEOUT_MS` | `retrieval.timeout_ms`. |
| `VESTIGIO_OBELISK_HOME` | `history.obelisk_home`. |
| `VESTIGIO_OBELISK_CLI` | `history.obelisk_cli`. |
| `VESTIGIO_DECISION_LOG` | `logging.decision_log`. |
| `VESTIGIO_ACTIVITY` | `logging.activity`. Use `1` or `0`. |

The extension reads the file once, at load time, which is when pi starts. Restart pi after you edit it. The daemon reads the file when it starts, so run `vestigio stop` before you change a setting the daemon uses.
