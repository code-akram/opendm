import { Plugin } from "@opencode-ai/plugin/effect"
import { Session } from "@opencode-ai/schema/session"
import { Tool } from "@opencode-ai/schema/tool"
import type { SystemPart } from "@opencode-ai/ai"
import { Effect, Schema } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import { createRoster } from "./roster.js"

const roster = createRoster({ dir: path.join(os.homedir(), ".opendm") })

const toolError = (message: string) => new Tool.Error({ message })

const DM_PREFIX = "[DM from "

/** `name-ses_ab12…`, so a DM header stays readable in the TUI. */
const displaySender = (name: string | undefined, sessionID: Session.ID) =>
  name ? `${name}-${sessionID.slice(0, 12)}…` : sessionID

export default Plugin.define({
  id: "dm",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.session.hook("context", (event) => {
        const last = event.messages.at(-1)
        const meta = last?.role === "user" ? last.metadata : undefined
        const isDm = meta?.dm === true && typeof meta.from === "string"
        if (isDm) {
          const from = String(meta.from)
          const fromName = typeof meta.fromName === "string" ? meta.fromName : from
          const type = typeof meta.message_type === "string" ? meta.message_type : "task"
          const thread = typeof meta.thread_id === "string" ? meta.thread_id : null
          event.system.push({
            type: "text",
            text: `You just received a DM from "${fromName}" (session ${from}, type: ${type}${thread ? `, thread: ${thread}` : ""}). Acknowledge it briefly, act on it if it is addressed to you, and reply using the dm tool if a reply is expected — questions and tasks expect a reply, status messages do not. When replying, reuse thread_id "${thread}" if present and set delivery "steer". You do not need to wait for replies to your own DMs — continue your work.`,
          } satisfies SystemPart)
        }
        return Effect.succeed(void 0)
      })

      yield* ctx.tool.transform((tools) => {
        tools.add({
          name: "register",
          description: "Register this session under a friendly name, linked to its session ID",
          input: Schema.Struct({ name: Schema.String }),
          output: Schema.String,
          options: { codemode: false },
          execute: ({ name }, { sessionID }) =>
            roster.register(name, sessionID).pipe(
              Effect.map(({ displaced }) => {
                const text =
                  `registered "${name}" (${sessionID})` +
                  (displaced ? ` — note: this name was previously bound to ${displaced}` : "")
                return { output: text, content: text }
              }),
              Effect.mapError(() => toolError("register failed")),
            ),
        })

        tools.add({
          name: "who",
          description: "List registered sessions (name → session ID, most recently registered first)",
          input: Schema.Struct({}),
          output: Schema.String,
          options: { codemode: false },
          execute: () =>
            roster.read.pipe(
              Effect.map((current) => {
                const lines = roster.list(current).map(
                  ({ name, entry }) =>
                    `${name} → ${entry.id} (registered ${new Date(entry.registeredAt).toISOString()})`,
                )
                const text = lines.length > 0 ? lines.join("\n") : "no sessions registered"
                return { output: text, content: text }
              }),
              Effect.mapError(() => toolError("who failed")),
            ),
        })

        tools.add({
          name: "dm",
          description:
            "DM another session by registered name or raw session ID. delivery: steer = interrupt the receiver now, queue = deliver on its next turn. message_type: task, question, status, or review — the receiver decides whether to reply. thread_id groups a conversation (max 64 chars). priority: urgent, normal, or low.",
          input: Schema.Struct({
            to: Schema.String,
            content: Schema.String,
            delivery: Schema.Literals(["steer", "queue"]),
            message_type: Schema.optional(Schema.Literals(["task", "question", "status", "review"])),
            thread_id: Schema.optional(Schema.String),
            priority: Schema.optional(Schema.Literals(["urgent", "normal", "low"])),
          }),
          output: Schema.String,
          options: { codemode: false },
          execute: ({ to, content, delivery, message_type, thread_id, priority }, { sessionID }) =>
            roster.read.pipe(
              Effect.flatMap((current) => {
                const resolved = roster.resolve(current, to)

                if (resolved.kind === "unknown-name") {
                  const known =
                    resolved.known.length > 0 ? ` Known: ${resolved.known.join(", ")}.` : ""
                  return Effect.fail(
                    toolError(
                      `no session registered as "${to}".${known} Register it first, or pass a raw session ID starting with ses_.`,
                    ),
                  )
                }

                const senderName = roster.nameFor(current, sessionID)
                const sender = displaySender(senderName, sessionID)
                return ctx.session
                  .prompt({
                    sessionID: resolved.id as Session.ID,
                    text: `${DM_PREFIX}${sender}] ${content}`,
                    metadata: {
                      from: sessionID,
                      fromName: senderName ?? sessionID,
                      dm: true,
                      ...(message_type ? { message_type } : {}),
                      ...(thread_id ? { thread_id } : {}),
                      ...(priority ? { priority } : {}),
                    },
                    delivery,
                  })
                  .pipe(
                    Effect.map(() => ({
                      // "admitted" is the honest claim: prompt() returning means
                      // the input is durably queued for the target — not that
                      // the target read it or acted on it.
                      output: "admitted",
                      content: `admitted to ${senderName ? `"${senderName}"` : to} (${resolved.id}, ${delivery}) — delivery receipt, not a read receipt`,
                    })),
                  )
              }),
              Effect.mapError((error) =>
                error instanceof Tool.Error ? error : toolError(`delivery failed to ${to}`),
              ),
            ),
        })
      })
    }),
})