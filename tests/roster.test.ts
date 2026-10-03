import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRoster, normalize } from "../src/roster.js"

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A>)

const tmpRoster = async (options: Parameters<typeof createRoster>[0] extends infer T ? Partial<T> : never = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opendm-test-"))
  const store = createRoster({ dir, ...options })
  return { dir, store, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

describe("normalize", () => {
  test("accepts the pre-presence { id, updatedAt } shape", () => {
    const roster = normalize({ planner: { id: "ses_a", updatedAt: 1000 } })
    expect(roster.planner).toEqual({ id: "ses_a", lastSeen: 1000, registeredAt: 1000 })
  })

  test("keeps current shape intact", () => {
    const roster = normalize({ planner: { id: "ses_a", lastSeen: 50, registeredAt: 10 } })
    expect(roster.planner).toEqual({ id: "ses_a", lastSeen: 50, registeredAt: 10 })
  })

  test("skips malformed entries instead of throwing", () => {
    expect(normalize({ a: { id: "ses_a" }, b: null, c: "nope", d: { id: 7 } })).toEqual({
      a: { id: "ses_a", lastSeen: 0, registeredAt: 0 },
    })
  })

  test("survives garbage input", () => {
    expect(normalize(null)).toEqual({})
    expect(normalize("nope")).toEqual({})
    expect(normalize(undefined)).toEqual({})
  })
})

describe("concurrent writes", () => {
  test("parallel registers do not lose entries", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      // The bug this guards: each writer read the same snapshot, so the last
      // write erased every earlier registration.
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => run(store.register(`session-${i}`, `ses_${i}`))),
      )
      const roster = await run(store.read)
      expect(Object.keys(roster).sort()).toEqual(
        Array.from({ length: 25 }, (_, i) => `session-${i}`).sort(),
      )
      for (let i = 0; i < 25; i++) expect(roster[`session-${i}`].id).toBe(`ses_${i}`)
    } finally {
      await cleanup()
    }
  })

  test("interleaved registers and touches keep every name bound correctly", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      await Promise.all([
        run(store.register("planner", "ses_p")),
        run(store.register("backend", "ses_b")),
        run(store.touch("ses_p")),
        run(store.touch("ses_b")),
        run(store.register("tests", "ses_t")),
      ])
      const roster = await run(store.read)
      expect(roster.planner?.id).toBe("ses_p")
      expect(roster.backend?.id).toBe("ses_b")
      expect(roster.tests?.id).toBe("ses_t")
    } finally {
      await cleanup()
    }
  })

  test("readers never observe a partial file", async () => {
    const { store, dir, cleanup } = await tmpRoster()
    try {
      const writes = Promise.all(
        Array.from({ length: 40 }, (_, i) => run(store.register(`s${i}`, `ses_${i}`))),
      )
      const reads = (async () => {
        for (let i = 0; i < 200; i++) await run(store.read)
      })()
      await Promise.all([writes, reads])
      const raw = await fs.readFile(path.join(dir, "roster.json"), "utf8")
      expect(() => JSON.parse(raw)).not.toThrow()
    } finally {
      await cleanup()
    }
  })

  test("does not leave a lock file behind", async () => {
    const { store, dir, cleanup } = await tmpRoster()
    try {
      await run(store.register("planner", "ses_p"))
      await expect(fs.stat(path.join(dir, "roster.lock"))).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })
})

describe("presence", () => {
  test("touch refreshes lastSeen for a registered session", async () => {
    const { store, cleanup } = await tmpRoster({ ttlMs: 50 })
    try {
      await run(store.register("planner", "ses_p"))
      await new Promise((r) => setTimeout(r, 80))
      expect((await run(store.read)).planner?.lastSeen).toBeLessThan(Date.now())
      await run(store.touch("ses_p"))
      const roster = await run(store.read)
      expect(roster.planner?.lastSeen).toBeGreaterThan(Date.now() - 50)
    } finally {
      await cleanup()
    }
  })

  test("touch revives an entry that aged out", async () => {
    const { store, cleanup } = await tmpRoster({ ttlMs: 40, reapMs: 60 * 60_000 })
    try {
      await run(store.register("planner", "ses_p"))
      await new Promise((r) => setTimeout(r, 70))
      expect(store.resolve(await run(store.read), "planner", Date.now()).kind).toBe("stale")
      await run(store.touch("ses_p"))
      expect(store.resolve(await run(store.read), "planner", Date.now()).kind).toBe("ok")
    } finally {
      await cleanup()
    }
  })

  test("reap drops entries older than reapMs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opendm-test-"))
    try {
      const store = createRoster({ dir, ttlMs: 10, reapMs: 50 })
      await run(store.register("ancient", "ses_a"))
      await new Promise((r) => setTimeout(r, 90))
      await run(store.register("fresh", "ses_f"))
      const roster = await run(store.read)
      expect(roster.ancient).toBeUndefined()
      expect(roster.fresh).toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("resolve", () => {
  const rosterAt = (now: number) => ({
    live: { id: "ses_live", lastSeen: now, registeredAt: 0 },
    dead: { id: "ses_dead", lastSeen: now - 10_000, registeredAt: 0 },
  })

  test("resolves a live name", async () => {
    const { store, cleanup } = await tmpRoster({ ttlMs: 5_000 })
    try {
      const now = Date.now()
      const result = store.resolve(rosterAt(now) as never, "live", now)
      expect(result).toEqual({ kind: "ok", id: "ses_live", name: "live" })
    } finally {
      await cleanup()
    }
  })

  test("reports a stale name instead of delivering to it", () => {
    const now = Date.now()
    const result = createRoster({ dir: "/tmp/unused", ttlMs: 5_000 }).resolve(
      rosterAt(now) as never,
      "dead",
      now,
    )
    expect(result.kind).toBe("stale")
    expect(result.kind === "stale" && result.id).toBe("ses_dead")
  })

  test("accepts a raw session id", () => {
    const result = createRoster({ dir: "/tmp/unused" }).resolve({} as never, "ses_whatever", Date.now())
    expect(result).toEqual({ kind: "ok", id: "ses_whatever" })
  })

  test("rejects an unknown name rather than casting it to a session id", () => {
    // This is the "ghost name" bug: a typo used to be sent as a session id
    // and reported as a successful delivery.
    const now = Date.now()
    const result = createRoster({ dir: "/tmp/unused" }).resolve(
      { planner: { id: "ses_p", lastSeen: now, registeredAt: 0 } } as never,
      "planer",
      now,
    )
    expect(result).toEqual({ kind: "unknown-name", known: ["planner"] })
  })
})

describe("register", () => {
  test("reports a name being taken over by a different session", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      await run(store.register("planner", "ses_old"))
      const { displaced } = await run(store.register("planner", "ses_new"))
      expect(displaced).toBe("ses_old")
      expect((await run(store.read)).planner?.id).toBe("ses_new")
    } finally {
      await cleanup()
    }
  })

  test("re-registering the same session is not a takeover", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      await run(store.register("planner", "ses_p"))
      const { displaced } = await run(store.register("planner", "ses_p"))
      expect(displaced).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test("re-registering preserves original registeredAt", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      await run(store.register("planner", "ses_p"))
      const before = (await run(store.read)).planner?.registeredAt
      await run(store.register("planner", "ses_p"))
      expect((await run(store.read)).planner?.registeredAt).toBe(before)
    } finally {
      await cleanup()
    }
  })
})