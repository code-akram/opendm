import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

/**
 * Roster storage for the dm plugin.
 *
 * Invariants:
 * - Writes are atomic (tmp file + rename), so readers never observe a partial
 *   file and reads need no lock.
 * - The read-modify-write cycle is serialized by an exclusive lock file. This
 *   is the part that needs mutual exclusion: two sessions registering at the
 *   same moment would otherwise each read the same snapshot and the second
 *   write would erase the first.
 * - `lastSeen` is presence. A session refreshes it on every turn, which also
 *   revives an entry that aged out while the session was closed.
 *
 * Session ids are plain strings here so this module has no dependency on the
 * opencode schema; the plugin casts at the boundary.
 */

export type Entry = { id: string; lastSeen: number; registeredAt: number }
export type Roster = Record<string, Entry>

export type Resolution =
  | { kind: "ok"; id: string; name?: string }
  | { kind: "unknown-name"; known: string[] }
  | { kind: "stale"; id: string; idleMs: number }

export type RosterOptions = {
  dir: string
  ttlMs?: number
  reapMs?: number
  lockWaitMs?: number
  lockStaleMs?: number
}

const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/**
 * Accepts the current `{ id, lastSeen, registeredAt }` shape and the older
 * `{ id, updatedAt }` shape written before presence existed, so rosters created
 * by earlier versions keep working with no migration step. An entry in the old
 * shape is treated as last seen when it was registered, which reads as stale
 * until the owning session takes its next turn and self-heals.
 */
export const normalize = (raw: unknown): Roster => {
  const out: Roster = {}
  if (typeof raw !== "object" || raw === null) return out
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== "string") continue
    const registeredAt = optionalNumber(entry.registeredAt) ?? optionalNumber(entry.updatedAt) ?? 0
    out[name] = {
      id: entry.id,
      lastSeen: optionalNumber(entry.lastSeen) ?? registeredAt,
      registeredAt,
    }
  }
  return out
}

export const createRoster = (options: RosterOptions) => {
  const rosterPath = path.join(options.dir, "roster.json")
  const lockPath = path.join(options.dir, "roster.lock")
  const ttlMs = options.ttlMs ?? 5 * 60_000
  const reapMs = options.reapMs ?? 60 * 60_000
  const lockWaitMs = options.lockWaitMs ?? 5_000
  const lockStaleMs = options.lockStaleMs ?? 15_000

  const isLive = (entry: Entry, now: number) => now - entry.lastSeen < ttlMs

  const prune = (roster: Roster, now: number) =>
    Object.fromEntries(Object.entries(roster).filter(([, entry]) => now - entry.lastSeen < reapMs))

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
        await fs.writeFile(tmp, JSON.stringify(prune(roster, now), null, 2))
        await fs.rename(tmp, rosterPath)
        return result
      }).pipe(Effect.ensuring(releaseLock))
    })

  const register = (name: string, id: string) =>
    mutate((roster, now) => {
      const previous = roster[name]
      const displaced = previous && previous.id !== id ? previous.id : undefined
      roster[name] = { id, lastSeen: now, registeredAt: previous?.registeredAt ?? now }
      return { displaced }
    })

  /** Refresh presence for every name bound to this session id. */
  const touch = (id: string) =>
    mutate((roster, now) => {
      for (const entry of Object.values(roster)) {
        if (entry.id === id) entry.lastSeen = now
      }
      return undefined
    })

  const nameFor = (roster: Roster, id: string) =>
    Object.entries(roster).find(([, entry]) => entry.id === id)?.[0]

  const list = (roster: Roster, now: number) =>
    Object.entries(roster)
      .sort((a, b) => {
        const live = Number(isLive(b[1], now)) - Number(isLive(a[1], now))
        return live !== 0 ? live : b[1].lastSeen - a[1].lastSeen
      })
      .map(([name, entry]) => ({ name, entry, live: isLive(entry, now) }))

  /**
   * Strict resolution: a registered name, or a raw `ses_` id. An unknown name
   * is an error rather than being cast to a session id, which previously sent
   * typos to a garbage target and reported success.
   */
  const resolve = (roster: Roster, to: string, now: number): Resolution => {
    const entry = roster[to]
    if (entry) {
      if (!isLive(entry, now)) {
        return { kind: "stale", id: entry.id, idleMs: now - entry.lastSeen }
      }
      return { kind: "ok", id: entry.id, name: to }
    }
    if (to.startsWith("ses_")) return { kind: "ok", id: to }
    return { kind: "unknown-name", known: Object.keys(roster) }
  }

  return {
    path: rosterPath,
    ttlMs,
    read: readRoster,
    mutate,
    register,
    touch,
    nameFor,
    list,
    resolve,
    isLive,
  }
}

export type RosterStore = ReturnType<typeof createRoster>