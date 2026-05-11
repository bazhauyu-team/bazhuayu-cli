# Agent Usage

`octopus` is designed to be safe for human operators and predictable for agents. Agents should prefer the machine surfaces below and avoid parsing human-readable text.

## Discovery

```bash
octopus capabilities --json
octopus --help
octopus data export --help
```

`capabilities --json` is the stable discovery entrypoint for automation.
Versioned schema paths are published under `data.machineContract.schemas`; see `docs/SCHEMAS.md`.

## Output contract

Use `--json` for request/response commands. The CLI writes exactly one JSON object to stdout:

```json
{
  "ok": true,
  "data": {}
}
```

Failures use the same envelope:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "human-readable message"
  }
}
```

This includes usage failures when `--json` is present, for example missing identifiers or unsupported flags. Common error codes are discoverable from `octopus capabilities --json` under `data.machineContract.json.commonErrorCodes`.

Use `--jsonl` for foreground local runs:

```bash
octopus run <taskId> --jsonl
```

Each line is one event object. Agents should switch on the stable `event` field.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | Operation failed |
| 2 | Runtime/environment failure |
| 3 | Unsupported task definition |

Treat any non-zero code as a failed operation.

## Authentication

An API key is required for all functional commands, including local `--task-file` and `.otd` runs. Only discovery/setup diagnostics (`--help`, `--version`, `capabilities`, `doctor`, `browser doctor`, `auth`, and `env`) are allowed before authentication.

Non-interactive setup:

```bash
printf '%s' "$API_KEY" | octopus auth login --stdin --json
```

`auth login` verifies the key before writing `~/.octopus/credentials.json`. Invalid, expired, or environment-mismatched keys fail with `AUTH_INVALID` and are not saved.

Environment variables:

```bash
OCTOPUS_API_KEY=<api-key>
OCTOPUS_API_BASE_URL=https://example.com
```

`OCTOPUS_API_KEY` overrides stored credentials.

## Recommended agent workflows

List tasks:

```bash
octopus task list --json
```

Inspect a task before running:

```bash
octopus task inspect <taskId> --json
```

Start local collection without blocking the current process:

```bash
octopus run <taskId> --detach --json
```

Detached startup returns `bootstrapDir`, `stdout`, and `stderr` when the child is spawned. If the child exits before the local control socket becomes available, the command fails with `DETACHED_RUN_FAILED`; inspect `<bootstrapDir>/bootstrap.json`, `stdout.log`, and `stderr.log`.

Control local collection:

```bash
octopus local status <taskId> --json
octopus local stop <taskId> --json
octopus local cleanup --json
```

If a detached or foreground owner process exits before removing its control file, `local status` reports `status: "orphaned"` and includes `lastStatus`. `local cleanup` removes stale task-level control files whose socket is gone.

Start/stop cloud collection:

```bash
octopus cloud start <taskId> --json
octopus cloud stop <taskId> --json
octopus cloud status <taskId> --json
```

Export data through the unified data surface:

```bash
octopus data export <taskId> --source local --format xlsx --json
octopus data export <taskId> --source cloud --format csv --json
octopus data export <taskId> --source cloud --lot-id <lotId> --file result.csv --json
```

If `--file` is omitted, the CLI creates a file from the task name. Existing files are not overwritten; the CLI appends Windows-style suffixes such as ` (1)` and ` (2)`.

Clean stale run-level control artifacts:

```bash
octopus runs cleanup --output ./runs --json
```

## Agent rules

- Prefer `--json` or `--jsonl`.
- Authenticate first; do not assume local task files bypass API key requirements.
- Do not parse human-readable output.
- Use `taskId` for user-facing task operations.
- Use `lotId` only to select a specific collection batch.
- Do not use `runId` unless inspecting internal local artifacts.
- Cloud collection has `start` and `stop`; it has no `pause` or `resume`.
