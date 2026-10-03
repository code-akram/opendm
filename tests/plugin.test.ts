import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import plugin from "../src/dm.js"

/**
 * Guards the two integration contracts that unit tests cannot see, both found
 * by running the plugin inside a real OpenCode server:
 *
 * 1. Tool input/output must be plain JSON Schema, not an Effect Schema. The
 *    types accept either (`Tool.ValueSchema` is a union), so this regresses
 *    silently — and the server rejects it at call time with
 *    "root: Expected object" even for a well-formed argument object.
 *
 * 2. The plugin entry point must be `<dir>/index.ts`. The loader ignores
 *    package.json "exports" and logs nothing when the file is absent, so a
 *    missing re-export makes the plugin vanish without any error.
 */

type Registered = {
  name: string
  input?: unknown
  output?: unknown
  options?: { codemode?: boolean }
}

/** Runs the plugin's tool transform against a recording draft. */
const registeredTools = async (): Promise<Registered[]> => {
  const found: Registered[] = []
  const ctx = {
    session: { hook: () => Effect.succeed(undefined) },
    tool: {
      transform: (fn: (draft: { add: (tool: Registered) => void }) => unknown) => {
        fn({ add: (tool) => found.push(tool) })
        return Effect.succeed(undefined)
      },
    },
  }
  // biome-ignore lint/suspicious/noExplicitAny: exercising the plugin effect directly
  await Effect.runPromise(Effect.scoped((plugin as any).effect(ctx)))
  return found
}

const isJsonSchema = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Schema.isSchema(value) &&
  "type" in value

describe("tool schemas are JSON Schema, not Effect Schema", () => {
  const toolsPromise = registeredTools()

  test("all three tools registered", async () => {
    const tools = await toolsPromise
    expect(tools.map((t) => t.name).sort()).toEqual(["dm", "register", "who"])
  })

  test("inputs are plain JSON Schema objects", async () => {
    for (const tool of await toolsPromise) {
      expect(isJsonSchema(tool.input)).toBe(true)
      expect((tool.input as { type: string }).type).toBe("object")
    }
  })

  test("outputs are plain JSON Schema", async () => {
    for (const tool of await toolsPromise) {
      expect(isJsonSchema(tool.output)).toBe(true)
    }
  })

  test("the Effect-Schema form is what the server rejects", () => {
    // Documents why the above matters: Schema.Struct is a valid Codec and the
    // type union permits it, but OpenCode answers "root: Expected object".
    const struct = Schema.Struct({ name: Schema.String })
    expect(Schema.isSchema(struct)).toBe(true)
    expect(isJsonSchema(struct)).toBe(false)
  })

  test("register requires a string name", async () => {
    const tools = await toolsPromise
    const register = tools.find((t) => t.name === "register")!
    const input = register.input as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(input.required).toEqual(["name"])
    expect(input.properties.name).toEqual({ type: "string" })
  })

  test("dm requires to, content and delivery, and constrains delivery", async () => {
    const tools = await toolsPromise
    const dm = tools.find((t) => t.name === "dm")!
    const input = dm.input as {
      properties: Record<string, { enum?: string[] }>
      required: string[]
    }
    expect(input.required).toEqual(["to", "content", "delivery"])
    expect(input.properties.delivery.enum).toEqual(["steer", "queue"])
  })

  test("who takes no required arguments", async () => {
    const tools = await toolsPromise
    const who = tools.find((t) => t.name === "who")!
    const input = who.input as { properties: Record<string, unknown>; required?: string[] }
    expect(input.properties).toEqual({})
    expect(input.required ?? []).toEqual([])
  })

  test("tools stay out of codemode so they are direct-mode only", async () => {
    const tools = await toolsPromise
    for (const tool of tools) {
      expect(tool.options?.codemode).toBe(false)
    }
  })
})