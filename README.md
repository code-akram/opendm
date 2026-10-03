# opendm

Peer-to-peer direct messaging between opencode2 sessions (beta).

Sessions register a friendly name, discover each other, and DM back and forth — no server changes, no daemon, one plugin.

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["/path/to/opendm/src/dm.ts"]
}
```

Dependencies: `@opencode-ai/plugin@next`, `@opencode-ai/schema@next`, `effect` — install in the plugin's `package.json` (`bun install`). Restart or reload the service after changing the plugin.

## Tools

| Tool | Description |
|---|---|
| `register(name)` | Link this session's ID to a friendly name (stored in `~/.opendm/roster.json`) |
| `who` | List registered sessions (name → ID) and whether each is live |
| `dm(to, content, delivery, ...)` | DM by name or raw session ID |

`dm` metadata (all optional): `delivery` — `steer` (interrupt receiver now) or `queue` (next turn); `message_type` — `task` / `question` / `status` / `review`; `thread_id` — group a conversation (≤64 chars); `priority` — `urgent` / `normal` / `low`.

## Semantics

- **Adaptive replies** — the sender marks intent; the receiver decides whether to reply. The plugin injects guidance into the receiver's context: acknowledge, act, reply via `dm` if a reply is expected (questions/tasks yes, status no), reuse `thread_id`, and continue without waiting.
- **Visible delivery** — DMs arrive as user messages, rendered in the TUI, e.g. `[DM from planner-ses_02220e54…] spec is ready`. Full sender ID is in `metadata.from` for replies.
- **No daemon, no polling** — the roster is a JSON file; delivery uses the server's own session queue.
- **Presence** — each session refreshes `lastSeen` on every turn. `who` reports `live` or `stale`, and `dm` refuses a stale name instead of reporting a delivery that nobody will ever read. A session that takes a new turn automatically revives its own roster entry, so there is nothing to re-register by hand after a restart.
- **Strict addressing** — an unknown name is an error listing the known names. Raw `ses_…` IDs are always accepted, since liveness cannot be checked for a target that is not in the roster.

## Configuration

All optional, read at plugin load:

| Variable | Default | Purpose |
|---|---|---|
| `OPENDM_SESSION_TTL_MS` | `300000` | Idle time after which a session counts as stale |
| `OPENDM_SESSION_REAP_MS` | `3600000` | Idle time after which an entry is deleted from the roster |
| `OPENDM_LOCK_WAIT_MS` | `5000` | How long to wait for the roster write lock |
| `OPENDM_LOCK_STALE_MS` | `15000` | Age at which a leftover lock file is treated as abandoned |
| `OPENDM_TOUCH_THROTTLE_MS` | `5000` | Minimum gap between presence writes from one session |

## Storage

The roster lives at `~/.opendm/roster.json`.

Writes are atomic (temp file + `rename`), so readers never observe a partial file and reads take no lock. The read-modify-write cycle is serialized by an exclusive lock file at `~/.opendm/roster.lock`, with stale-lock reaping so a killed process cannot wedge the roster. Without that lock, concurrent registrations overwrite each other — 25 parallel `register` calls collapsed to a single surviving entry.

Entries are also accepted in the older `{ id, updatedAt }` shape, so rosters written before presence existed keep working without a migration step.

## Development

```bash
bun install
bun run typecheck
bun test
```

## Usage

"Register this session as planner" → "DM the backend session: auth spec is ready" → backend replies on the thread.

## License

MIT