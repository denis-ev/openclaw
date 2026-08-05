import { describe, expect, it, vi } from "vitest";
import {
  resolveAgentCommandRunAccounting,
  runWithAgentCommandAccounting,
} from "./run-accounting.js";

async function captureFailure(failure: unknown): Promise<Error> {
  let caught: unknown;
  const rejectFailure = vi.fn().mockRejectedValue(failure);
  try {
    await runWithAgentCommandAccounting(async () => await rejectFailure());
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

function expectAccounting(error: Error): void {
  expect(resolveAgentCommandRunAccounting(error)?.coverage.candidates).toEqual({
    state: "unavailable",
    reasons: ["not_observed"],
  });
}

describe("command run accounting error coercion", () => {
  it("preserves structured failures and accounts hostile thrown objects", async () => {
    const fakeSecret = `sk-${"a".repeat(22)}`;
    const structuredFailure = {
      code: "EPIPE",
      message: `OPENAI_API_KEY=${fakeSecret}`,
      status: 503,
    };
    const caughtStructured = await captureFailure(structuredFailure);
    expect(caughtStructured.message).not.toContain(fakeSecret);
    expect(caughtStructured.message).toContain("OPENAI_API_KEY=");
    expect(caughtStructured).toMatchObject({ code: "EPIPE", status: 503 });
    expect(caughtStructured.cause).toBe(structuredFailure);
    expectAccounting(caughtStructured);

    const nullPrototypeFailure = Object.assign(Object.create(null) as Record<string, unknown>, {
      code: "NULL_PROTO",
    });
    Object.defineProperty(nullPrototypeFailure, "__proto__", {
      enumerable: true,
      value: null,
    });
    const caughtNullPrototype = await captureFailure(nullPrototypeFailure);
    expect(Object.getPrototypeOf(caughtNullPrototype)).toBe(Error.prototype);
    expect(caughtNullPrototype.cause).toBe(nullPrototypeFailure);
    expectAccounting(caughtNullPrototype);

    const hostileFailure = new Proxy(Object.create(null) as object, {
      get() {
        throw new Error("property access failed");
      },
      getPrototypeOf() {
        throw new Error("prototype access failed");
      },
      ownKeys() {
        throw new Error("property enumeration failed");
      },
    });
    const caughtHostile = await captureFailure(hostileFailure);
    expect(caughtHostile.message).toBe("Unknown error");
    expect(caughtHostile.cause).toBe(hostileFailure);
    expectAccounting(caughtHostile);
  });
});
