import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  testing,
  WORKER_RESULT_SENTINEL,
  type MemorySample,
  type WorkerResult,
} from "../../scripts/bench-task-registry-sqlite.ts";

function memorySample(cycle: number): MemorySample {
  return {
    cycle,
    heapUsedBytes: 100 + cycle,
    rssBytes: 200 + cycle,
    externalBytes: 30 + cycle,
    arrayBuffersBytes: 10 + cycle,
    maxRssBytes: 250 + cycle,
  };
}

function workerResult(size: number, cycles = 3, warmup = 1): WorkerResult {
  return {
    size,
    timingsMs: {
      registration: Array.from({ length: cycles }, (_, index) => index + 1),
      terminal: Array.from({ length: cycles }, (_, index) => index + 2),
      teardown: Array.from({ length: cycles }, (_, index) => index + 3),
    },
    memory: {
      postGcSamples: Array.from({ length: cycles }, (_, index) => memorySample(index)),
      retainedSlopesBytesPerCycle: {
        heapUsedBytes: 1,
        rssBytes: 1,
        externalBytes: 1,
        arrayBuffersBytes: 1,
        maxRssBytes: 1,
      },
      processMaxRssBytes: 300,
    },
    invariant: {
      ok: true,
      cyclesValidated: cycles + warmup,
      registeredMemoryTasks: size,
      registeredMemoryDeliveryStates: size,
      registeredSqliteTasks: size,
      registeredSqliteDeliveryStates: size,
      postTeardownMemoryTasks: 0,
      postTeardownMemoryDeliveryStates: 0,
      postTeardownSqliteTasks: 0,
      postTeardownSqliteDeliveryStates: 0,
      serializedSharedConnection: true,
    },
  };
}

function workerStdout(result: WorkerResult): string {
  return `${WORKER_RESULT_SENTINEL}${JSON.stringify(result)}\n`;
}

describe("durable task registry churn benchmark", () => {
  it("parses bounded defaults and explicit options", () => {
    expect(testing.parseOptions([])).toMatchObject({
      sizes: [24, 64, 128],
      cycles: 20,
      warmup: 3,
    });
    expect(
      testing.parseOptions([
        "--sizes",
        "2,4",
        "--cycles",
        "5",
        "--warmup",
        "0",
        "--output",
        "bench.json",
        "--json",
      ]),
    ).toMatchObject({
      sizes: [2, 4],
      cycles: 5,
      warmup: 0,
      output: "bench.json",
      json: true,
    });
    expect(() => testing.parseOptions(["--sizes", "2,2"])).toThrow(
      "--sizes contains duplicate values",
    );
    expect(() => testing.parseOptions(["--cycles", "201"])).toThrow("--cycles must be at most 200");
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("always launches a fresh expose-gc worker for one size", () => {
    const options = testing.parseOptions(["--sizes", "8", "--cycles", "2", "--warmup", "1"]);
    expect(testing.buildWorkerArgs(options, 8)).toEqual([
      "--expose-gc",
      "--import",
      "tsx",
      "scripts/bench-task-registry-sqlite-worker.ts",
      "--size",
      "8",
      "--cycles",
      "2",
      "--warmup",
      "1",
    ]);
  });

  it("aggregates schema version 1 with raw memory samples and explicit interpretation", () => {
    const options = testing.parseOptions(["--sizes", "2,4", "--cycles", "3", "--warmup", "1"]);
    const report = testing.aggregateWorkerResults(options, [workerResult(2), workerResult(4)]);
    expect(report).toMatchObject({
      schemaVersion: 1,
      benchmark: "durable-task-registry-churn",
      model: {
        unit: "logical subagent registrations",
        isolation: "fresh --expose-gc worker process per size",
      },
      options: { sizes: [2, 4], cycles: 3, warmup: 1 },
      invariants: {
        ok: true,
        exactMemoryAndSqliteCounts: true,
        zeroRowsAfterEveryTeardown: true,
      },
    });
    expect(report.interpretation.timings).toContain("advisory only");
    expect(report.interpretation.memory).toContain("neither claim nor rule out a memory leak");
    expect(report.sizes[0]?.memory.postGcSamples).toHaveLength(3);
    expect(report.sizes[0]?.timingsMs.registration).toEqual({
      count: 3,
      min: 1,
      p50: 2,
      max: 3,
    });
    expect(JSON.stringify(report)).not.toContain(process.cwd());
  });

  it("rejects malformed, incomplete, failed, and timed-out worker results", () => {
    const expected = { size: 2, cycles: 3, warmup: 1 };
    const valid = workerResult(2);
    expect(
      testing.parseWorkerProcessResult(
        { status: 0, stdout: workerStdout(valid), stderr: "" },
        expected,
      ),
    ).toEqual(valid);
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 0, stdout: `${WORKER_RESULT_SENTINEL}{\n`, stderr: "" },
        expected,
      ),
    ).toThrow("returned invalid JSON");
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 0, stdout: workerStdout(workerResult(3)), stderr: "" },
        expected,
      ),
    ).toThrow("mismatched identity");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: 0,
          stdout: workerStdout({
            ...valid,
            memory: { ...valid.memory, postGcSamples: valid.memory.postGcSamples.slice(1) },
          }),
          stderr: "",
        },
        expected,
      ),
    ).toThrow("invalid post-GC sample count");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: 0,
          stdout: workerStdout({
            ...valid,
            invariant: { ...valid.invariant, postTeardownSqliteTasks: 1 },
          }),
          stderr: "",
        },
        expected,
      ),
    ).toThrow("reported a failed invariant");
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 7, stdout: "", stderr: "worker exploded" },
        expected,
      ),
    ).toThrow("failed (7): worker exploded");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
        },
        expected,
      ),
    ).toThrow("timed out after 300000ms");
  });

  it("runs a tiny durable create, terminal, delete smoke", () => {
    const smoke = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/bench-task-registry-sqlite.ts",
        "--sizes",
        "2",
        "--cycles",
        "1",
        "--warmup",
        "0",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        timeout: 120_000,
      },
    );
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(smoke.stderr).toContain("worker 1/1 complete size=2");
    const report = JSON.parse(smoke.stdout) as {
      invariants: { ok: boolean };
      sizes: Array<{ invariant: WorkerResult["invariant"] }>;
    };
    expect(report.invariants.ok).toBe(true);
    expect(report.sizes[0]?.invariant).toMatchObject({
      registeredMemoryTasks: 2,
      registeredMemoryDeliveryStates: 2,
      registeredSqliteTasks: 2,
      registeredSqliteDeliveryStates: 2,
      postTeardownMemoryTasks: 0,
      postTeardownMemoryDeliveryStates: 0,
      postTeardownSqliteTasks: 0,
      postTeardownSqliteDeliveryStates: 0,
    });
  });

  it("supports help and ends failures with the marker", () => {
    const help = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-task-registry-sqlite.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("OpenClaw durable task registry churn benchmark");
    expect(help.stdout).toContain("--sizes <list>");
    expect(help.stderr).toBe("");

    const failure = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-task-registry-sqlite.ts", "--wat"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-task-registry-sqlite] FAILED (exit 1)",
    );
  });
});
