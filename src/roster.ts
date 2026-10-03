import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

/**
 * Roster storage for the dm plugin: a name → session id map.
 *
 * Invariants:
 * - Writes are atomic (tmp file + rename), so readers never observe a partial
 *   file and reads need no lock.
 * - The read-modify-write cycle is serialized by an exclusive lock file. This
 *   is the part that needs mutual exclusion: two sessions registering at the
 *   same moment would otherwise each read the same snapshot and the second
 *   write would erase the first.
 *
 * There is deliberately no liveness tracking. OpenCode's session inbox is
 * durable, so a message admitted to a dormant session is still there when it
 * reopens — refusing to address such a session would discard a message that
 * would have been delivered. The session API exposes no status field either,
 * so any "is it alive" signal here would be a guess standing in for a fact we
 * do not have. Delivery failures surface from prompt() itself.
 *
 * Session ids are plain strings here so this module has no dependency on the
 * opencode schema; the plugin casts at the boundary.
 */

export type Entry = { id: string; registeredAt: number }
export type Roster = Record<string, Entry>

export type Resolution =
  | { kind: "ok"; id: string; name?: string }
  | { kind: "unknown-name"; known: string[] }

export type RosterOptions = {
  dir: string
  lockWaitMs?: number
  lockStaleMs?: number
}

const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/**
 * Accepts the current `{ id, registeredAt }` shape and older rosters that used
 * `updatedAt` or `lastSeen`, so files written by previous versions keep
 * working with no migration step.
 */
export const normalize = (raw: unknown): Roster => {
  const out: Roster = {}
  if (typeof raw !== "object" || raw === null) return out
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== "string") continue
    const registeredAt =
      optionalNumber(entry.registeredAt) ?? optionalNumber(entry.updatedAt) ?? optionalNumber(entry.lastSeen) ?? 0
    out[name] = { id: entry.id, registeredAt }
  }
  return out
}

export const createRoster = (options: RosterOptions) => {
  const rosterPath = path.join(options.dir, "roster.json")
  const lockPath = path.join(options.dir, "roster.lock")
  const lockWaitMs = options.lockWaitMs ?? 5_000
  const lockStaleMs = options.lockStaleMs ?? 15_000

  const parse = (raw: string) => {
    try {
      return normalize(JSON.parse(raw) as unknown)
    } catch {
      return {}
    }
  }

  const readRoster = Effect.tryPromise(async (): Promise<Roster> => {
    const raw = await fs.readFile(rosterPath, "utf8").catch(() => "{}")
    return parse(raw)
  })

  const sleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const attemptLock = Effect.tryPromise(async (): Promise<boolean> => {
    try {
      const handle = await fs.open(lockPath, "wx")
      await handle.writeFile(String(process.pid))
      await handle.close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
  })

  /** A lock left behind by a killed process would otherwise wedge the roster. */
  const reapStaleLock = Effect.tryPromise(async () => {
    const stat = await fs.stat(lockPath).catch(() => undefined)
    if (stat && Date.now() - stat.mtimeMs > lockStaleMs) {
      await fs.unlink(lockPath).catch(() => undefined)
    }
  })

  const releaseLock = Effect.promise(() => fs.unlink(lockPath).catch(() => undefined))

  let writeSeq = 0

  const acquireLock = Effect.gen(function* () {
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      if (yield* attemptLock) return
      yield* reapStaleLock
      if (Date.now() > deadline) return yield* Effect.fail(new Error(`timed out waiting for ${lockPath}`))
      yield* sleep(5)
    }
  })

  const mutate = <A>(update: (roster: Roster, now: number) => A) =>
    Effect.gen(function* () {
      yield* acquireLock
      return yield* Effect.tryPromise(async () => {
        const now = Date.now()
        const raw = await fs.readFile(rosterPath, "utf8").catch(() => "{}")
        const roster = parse(raw)
        const result = update(roster, now)
        await fs.mkdir(options.dir, { recursive: true })
        // Unique per write, not just per process: two writers in one process
        // would otherwise share a tmp path and clobber each other's file.
        const tmp = `${rosterPath}.${process.pid}.${writeSeq++}.tmp`
        await fs.writeFile(tmp, JSON.stringify(roster, null, 2))
        await fs.rename(tmp, rosterPath)
        return result
      }).pipe(Effect.ensuring(releaseLock))
    })

  const register = (name: string, id: string) =>
    mutate((roster, now) => {
      const previous = roster[name]
      const displaced = previous && previous.id !== id ? previous.id : undefined
      roster[name] = { id, registeredAt: previous?.registeredAt ?? now }
      return { displaced }
    })

  const nameFor = (roster: Roster, id: string) =>
    Object.entries(roster).find(([, entry]) => entry.id === id)?.[0]

  const list = (roster: Roster) =>
    Object.entries(roster)
      .sort((a, b) => b[1].registeredAt - a[1].registeredAt)
      .map(([name, entry]) => ({ name, entry }))

  /**
   * Strict resolution: a registered name, or a raw `ses_` id. An unknown name
   * is an error rather than being cast to a session id, which previously sent
   * typos to a garbage target and reported success.
   */
  const resolve = (roster: Roster, to: string): Resolution => {
    const entry = roster[to]
    if (entry) return { kind: "ok", id: entry.id, name: to }
    if (to.startsWith("ses_")) return { kind: "ok", id: to }
    return { kind: "unknown-name", known: Object.keys(roster) }
  }

  return {
    path: rosterPath,
    read: readRoster,
    mutate,
    register,
    nameFor,
    list,
    resolve,
  }
}

export type RosterStore = ReturnType<typeof createRoster>