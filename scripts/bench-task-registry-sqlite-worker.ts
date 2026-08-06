import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { DB as OpenClawStateKyselyDatabase } from "../src/state/openclaw-state-db.generated.js";
import {
  WORKER_RESULT_SENTINEL,
  type MemorySample,
  type MemorySlopes,
  type WorkerResult,
} from "./bench-task-registry-sqlite.js";

type WorkerOptions = {
  size: number;
  cycles: number;
  warmup: number;
};

type RegistryCounts = {
  memoryTasks: number;
  memoryDeliveryStates: number;
  sqliteTasks: number;
  sqliteDeliveryStates: number;
};

type TimingSample = {
  registrationMs: number;
  terminalMs: number;
  teardownMs: number;
  registered: RegistryCounts;
  teardown: RegistryCounts;
};

type BenchmarkStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_delivery_state" | "task_runs"
>;

function parseInteger(raw: string | undefined, flag: string, min: number, max: number): number {
  if (!raw || !/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be an integer`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${flag} must be between ${min} and ${max}`);
  }
  return value;
}

function parseOptions(argv: string[]): WorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid worker argument near ${flag ?? "end"}`);
    }
    if (values.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    values.set(flag, value);
  }
  return {
    size: parseInteger(values.get("--size"), "--size", 1, 4096),
    cycles: parseInteger(values.get("--cycles"), "--cycles", 1, 200),
    warmup: parseInteger(values.get("--warmup"), "--warmup", 0, 20),
  };
}

function processMaxRssBytes(): number {
  return Math.max(0, Math.round(process.resourceUsage().maxRSS * 1024));
}

function forceGc(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!gc) {
    throw new Error("benchmark worker requires --expose-gc");
  }
  gc();
  gc();
}

function readMemorySample(cycle: number): MemorySample {
  const memory = process.memoryUsage();
  return {
    cycle,
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    maxRssBytes: processMaxRssBytes(),
  };
}

function slope(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * ((values[index] ?? 0) - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function memorySlopes(samples: MemorySample[]): MemorySlopes {
  return {
    heapUsedBytes: slope(samples.map((sample) => sample.heapUsedBytes)),
    rssBytes: slope(samples.map((sample) => sample.rssBytes)),
    externalBytes: slope(samples.map((sample) => sample.externalBytes)),
    arrayBuffersBytes: slope(samples.map((sample) => sample.arrayBuffersBytes)),
    maxRssBytes: slope(samples.map((sample) => sample.maxRssBytes)),
  };
}

function assertCounts(actual: RegistryCounts, expected: number, phase: string): void {
  if (
    actual.memoryTasks !== expected ||
    actual.memoryDeliveryStates !== expected ||
    actual.sqliteTasks !== expected ||
    actual.sqliteDeliveryStates !== expected
  ) {
    throw new Error(`${phase} count invariant failed: ${JSON.stringify({ expected, actual })}`);
  }
}

async function createCountReader() {
  const [{ executeSqliteQuerySync, getNodeSqliteKysely }, stateDb, state] = await Promise.all([
    import("../src/infra/kysely-sync.js"),
    import("../src/state/openclaw-state-db.js"),
    import("../src/tasks/task-registry-state.js"),
  ]);
  return () => {
    const database = stateDb.openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<BenchmarkStateDatabase>(database.db);
    const taskRows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("task_runs").select(({ fn }) => fn.countAll<number>().as("count")),
    ).rows[0]?.count;
    const deliveryRows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("task_delivery_state").select(({ fn }) => fn.countAll<number>().as("count")),
    ).rows[0]?.count;
    return {
      memoryTasks: state.tasks.size,
      memoryDeliveryStates: state.taskDeliveryStates.size,
      sqliteTasks: Number(taskRows ?? 0),
      sqliteDeliveryStates: Number(deliveryRows ?? 0),
    };
  };
}

async function runCycle(
  size: number,
  serial: number,
  readCounts: () => RegistryCounts,
): Promise<TimingSample> {
  const taskRegistry = await import("../src/tasks/task-registry.js");
  const taskIds: string[] = [];
  const startedAt = Date.now();
  const registrationStartedAt = performance.now();
  for (let index = 0; index < size; index += 1) {
    const task = taskRegistry.createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:benchmark:main",
      ownerKey: "agent:benchmark:main",
      scopeKind: "session",
      requesterOrigin: { channel: "benchmark", to: "task-registry" },
      childSessionKey: `agent:benchmark:subagent:${serial}:${index}`,
      runId: `benchmark-task-${serial}-${index}`,
      task: `durable registration benchmark ${index}`,
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt,
      lastEventAt: startedAt,
    });
    if (!task) {
      throw new Error(`task registration failed at ${index + 1}/${size}`);
    }
    taskIds.push(task.taskId);
  }
  const registrationMs = performance.now() - registrationStartedAt;
  const registered = readCounts();
  assertCounts(registered, size, "registration");

  const terminalStartedAt = performance.now();
  for (const taskId of taskIds) {
    const endedAt = Date.now();
    const task = taskRegistry.markTaskTerminalById({
      taskId,
      status: "succeeded",
      endedAt,
      lastEventAt: endedAt,
      terminalOutcome: "succeeded",
    });
    if (!task) {
      throw new Error(`terminal transition failed for task ${taskId}`);
    }
  }
  const terminalMs = performance.now() - terminalStartedAt;

  const teardownStartedAt = performance.now();
  for (const taskId of taskIds) {
    if (!taskRegistry.deleteTaskRecordById(taskId)) {
      throw new Error(`teardown failed for task ${taskId}`);
    }
  }
  const teardownMs = performance.now() - teardownStartedAt;
  const teardown = readCounts();
  assertCounts(teardown, 0, "teardown");
  return { registrationMs, terminalMs, teardownMs, registered, teardown };
}

async function resetRuntime(persist: boolean): Promise<void> {
  const [tasks, stateDb] = await Promise.all([
    import("../src/tasks/task-runtime.test-helpers.js"),
    import("../src/state/openclaw-state-db.js"),
  ]);
  tasks.resetTaskRegistryForTests({ persist });
  stateDb.closeOpenClawStateDatabaseForTest();
}

async function runBenchmark(options: WorkerOptions): Promise<WorkerResult> {
  await resetRuntime(true);
  const readCounts = await createCountReader();
  assertCounts(readCounts(), 0, "initial");
  const timingsMs = {
    registration: [] as number[],
    terminal: [] as number[],
    teardown: [] as number[],
  };
  const postGcSamples: MemorySample[] = [];
  let lastSample: TimingSample | undefined;
  for (let index = 0; index < options.warmup + options.cycles; index += 1) {
    lastSample = await runCycle(options.size, index, readCounts);
    forceGc();
    if (index >= options.warmup) {
      timingsMs.registration.push(lastSample.registrationMs);
      timingsMs.terminal.push(lastSample.terminalMs);
      timingsMs.teardown.push(lastSample.teardownMs);
      postGcSamples.push(readMemorySample(index - options.warmup));
    }
  }
  if (!lastSample) {
    throw new Error("benchmark completed without a cycle");
  }
  return {
    size: options.size,
    timingsMs,
    memory: {
      postGcSamples,
      retainedSlopesBytesPerCycle: memorySlopes(postGcSamples),
      processMaxRssBytes: processMaxRssBytes(),
    },
    invariant: {
      ok: true,
      cyclesValidated: options.warmup + options.cycles,
      registeredMemoryTasks: lastSample.registered.memoryTasks,
      registeredMemoryDeliveryStates: lastSample.registered.memoryDeliveryStates,
      registeredSqliteTasks: lastSample.registered.sqliteTasks,
      registeredSqliteDeliveryStates: lastSample.registered.sqliteDeliveryStates,
      postTeardownMemoryTasks: lastSample.teardown.memoryTasks,
      postTeardownMemoryDeliveryStates: lastSample.teardown.memoryDeliveryStates,
      postTeardownSqliteTasks: lastSample.teardown.sqliteTasks,
      postTeardownSqliteDeliveryStates: lastSample.teardown.sqliteDeliveryStates,
      serializedSharedConnection: true,
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-registry-bench-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  let result: WorkerResult | undefined;
  let failure: unknown;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.NODE_ENV = "test";
  try {
    const { pinRuntimePaths } = await import("../src/config/paths.js");
    pinRuntimePaths();
    result = await runBenchmark(options);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await resetRuntime(false);
    } catch (error) {
      failure ??= error;
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) {
    throw toError(failure);
  }
  if (!result) {
    throw new Error("benchmark worker completed without a result");
  }
  process.stdout.write(`${WORKER_RESULT_SENTINEL}${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    if (process.exitCode && process.exitCode !== 0) {
      console.error(`[bench-task-registry-sqlite-worker] FAILED (exit ${process.exitCode})`);
    }
  }
}
