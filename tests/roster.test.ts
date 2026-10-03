import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRoster, normalize } from "../src/roster.js"

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A>)

const tmpRoster = async (options: Partial<Parameters<typeof createRoster>[0]> = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opendm-test-"))
  const store = createRoster({ dir, ...options })
  return { dir, store, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

describe("normalize", () => {
  test("accepts the pre-presence { id, updatedAt } shape", () => {
    expect(normalize({ planner: { id: "ses_a", updatedAt: 1000 } })).toEqual({
      planner: { id: "ses_a", registeredAt: 1000 },
    })
  })

  test("accepts a roster that carried a lastSeen field", () => {
    expect(normalize({ planner: { id: "ses_a", lastSeen: 50, registeredAt: 10 } })).toEqual({
      planner: { id: "ses_a", registeredAt: 10 },
    })
  })

  test("keeps current shape intact", () => {
    expect(normalize({ planner: { id: "ses_a", registeredAt: 10 } })).toEqual({
      planner: { id: "ses_a", registeredAt: 10 },
    })
  })

  test("skips malformed entries instead of throwing", () => {
    expect(normalize({ a: { id: "ses_a" }, b: null, c: "nope", d: { id: 7 } })).toEqual({
      a: { id: "ses_a", registeredAt: 0 },
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
      // write erased every earlier registration. Unlocked, 25 of these
      // collapse to a single surviving entry.
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

  test("repeated rounds of parallel writes stay consistent", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      for (let round = 0; round < 5; round++) {
        await Promise.all(
          Array.from({ length: 10 }, (_, i) => run(store.register(`r${round}-s${i}`, `ses_${round}_${i}`))),
        )
      }
      const roster = await run(store.read)
      expect(Object.keys(roster)).toHaveLength(50)
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

  test("leaves no temp files behind", async () => {
    const { store, dir, cleanup } = await tmpRoster()
    try {
      await Promise.all(Array.from({ length: 10 }, (_, i) => run(store.register(`s${i}`, `ses_${i}`))))
      const files = await fs.readdir(dir)
      expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe("persistence", () => {
  test("entries survive a fresh store over the same directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opendm-test-"))
    try {
      await run(createRoster({ dir }).register("planner", "ses_p"))
      const reopened = await run(createRoster({ dir }).read)
      expect(reopened.planner?.id).toBe("ses_p")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("a corrupt roster file degrades to empty instead of throwing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opendm-test-"))
    try {
      await fs.writeFile(path.join(dir, "roster.json"), "{ not json")
      expect(await run(createRoster({ dir }).read)).toEqual({})
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("resolve", () => {
  const rosterOf = (entries: Record<string, { id: string; registeredAt: number }>) => entries as never

  test("resolves a registered name", () => {
    const result = createRoster({ dir: "/tmp/unused" }).resolve(rosterOf({ planner: { id: "ses_p", registeredAt: 0 } }), "planner")
    expect(result).toEqual({ kind: "ok", id: "ses_p", name: "planner" })
  })

  test("accepts a raw session id", () => {
    expect(createRoster({ dir: "/tmp/unused" }).resolve({} as never, "ses_whatever")).toEqual({
      kind: "ok",
      id: "ses_whatever",
    })
  })

  test("rejects an unknown name rather than casting it to a session id", () => {
    // This is the "ghost name" bug: a typo used to be sent as a session id
    // and reported as a successful delivery.
    expect(
      createRoster({ dir: "/tmp/unused" }).resolve(
        rosterOf({ planner: { id: "ses_p", registeredAt: 0 } }),
        "planer",
      ),
    ).toEqual({ kind: "unknown-name", known: ["planner"] })
  })

  test("a name registered long ago still resolves", () => {
    // No TTL: the inbox is durable, so a dormant session can still receive.
    const ancient = { id: "ses_old", registeredAt: 0 }
    expect(
      createRoster({ dir: "/tmp/unused" }).resolve(rosterOf({ ancient }), "ancient"),
    ).toEqual({ kind: "ok", id: "ses_old", name: "ancient" })
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

  test("re-registering preserves the original registeredAt", async () => {
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

  test("two sessions can both be registered under different names", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      await Promise.all([run(store.register("planner", "ses_p")), run(store.register("backend", "ses_b"))])
      const roster = await run(store.read)
      expect(roster.planner?.id).toBe("ses_p")
      expect(roster.backend?.id).toBe("ses_b")
    } finally {
      await cleanup()
    }
  })
})

describe("nameFor", () => {
  test("finds the name bound to a session id", async () => {
    const { store, cleanup } = await tmpRoster()
    try {
      await run(store.register("planner", "ses_p"))
      const roster = await run(store.read)
      expect(store.nameFor(roster, "ses_p")).toBe("planner")
      expect(store.nameFor(roster, "ses_unknown")).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})