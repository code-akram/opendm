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
| `who` | List registered sessions (name → ID, most recently registered first) |
| `dm(to, content, delivery, ...)` | DM by name or raw session ID |

`dm` metadata (all optional): `delivery` — `steer` (interrupt receiver now) or `queue` (next turn); `message_type` — `task` / `question` / `status` / `review`; `thread_id` — group a conversation (≤64 chars); `priority` — `urgent` / `normal` / `low`.

## Semantics

- **Adaptive replies** — the sender marks intent; the receiver decides whether to reply. The plugin injects guidance into the receiver's context: acknowledge, act, reply via `dm` if a reply is expected (questions/tasks yes, status no), reuse `thread_id`, and continue without waiting.
- **Visible delivery** — DMs arrive as user messages, rendered in the TUI, e.g. `[DM from planner-ses_02220e54…] spec is ready`. Full sender ID is in `metadata.from` for replies.
- **No daemon, no polling** — the roster is a JSON file; delivery uses the server's own session queue.
- **Strict addressing** — an unknown name is an error listing the known names. Raw `ses_…` IDs are always accepted.
- **Delivery receipts are honest** — `dm` reports `admitted`, meaning the input is durably queued for the target. That is not a read receipt; nothing here can tell you whether the target read or acted on it.

## No liveness tracking

The roster deliberately carries no heartbeat, TTL, or expiry.

The session API exposes no status field — `Session.Info` has only `time.created`, `time.updated`, and `time.archived` — so any "is this session alive" signal built here would be a guess standing in for a fact that is not available.

More importantly, it would be the wrong guess. OpenCode's inbox is durable: a message admitted to a dormant session is still queued when that session reopens. Refusing to address such a session would discard a message that would otherwise have been delivered. A TTL would therefore break exactly the sessions that are idle-but-alive — the common case when you step away from a terminal — while doing nothing for genuinely dead ones, since the server already reports those failures.

An earlier version had a 5-minute TTL. It was removed for this reason.

## Storage

The roster lives at `~/.opendm/roster.json`.

Writes are atomic (temp file + `rename`), so readers never observe a partial file and reads take no lock. The read-modify-write cycle is serialized by an exclusive lock file at `~/.opendm/roster.lock`, with stale-lock reaping so a killed process cannot wedge the roster. Without that lock, concurrent registrations overwrite each other — 25 parallel `register` calls collapsed to a single surviving entry.

Entries are accepted in older `{ id, updatedAt }` and `{ id, lastSeen }` shapes, so rosters written by earlier versions keep working without a migration step.

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