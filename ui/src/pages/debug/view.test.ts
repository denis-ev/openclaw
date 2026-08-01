// Control UI tests cover debug behavior.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./debug-page.ts";
import { renderDebug } from "./view.ts";

type DebugProps = Parameters<typeof renderDebug>[0];
type TestDebugPage = HTMLElement & {
  context: ApplicationContext;
  debugCallError: string | null;
  debugCallMethod: string;
  debugCallResult: string | null;
  debugStatus: unknown;
  loadDiagnostics: () => Promise<void>;
  requestUpdate: () => void;
  updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function mountDebugPage(
  request: (method: string) => Promise<unknown>,
): Promise<TestDebugPage> {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    phase: "connected",
    client,
    hello: { features: { methods: ["manual.first", "manual.latest"] } },
  } as ApplicationGatewaySnapshot;
  const gateway = {
    snapshot,
    eventLog: [],
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  const page = document.createElement("openclaw-debug-page") as TestDebugPage;
  page.context = { basePath: "", gateway } as ApplicationContext;
  document.body.append(page);
  await vi.waitFor(() => expect(page.debugStatus).not.toBeNull());
  await page.updateComplete;
  return page;
}

function clickManualCall(page: TestDebugPage): void {
  const button = [...page.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Call",
  );
  if (!button) {
    throw new Error("Expected the rendered manual RPC Call button");
  }
  button.click();
}

function diagnosticResponse(method: string): unknown {
  switch (method) {
    case "status":
      return { version: "healthy" };
    case "health":
      return { ok: true };
    case "models.list":
      return { models: [] };
    case "last-heartbeat":
      return null;
    default:
      throw new Error(`Unexpected diagnostics method: ${method}`);
  }
}

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    loading: false,
    status: null,
    health: null,
    models: [],
    heartbeat: null,
    eventLog: [],
    methods: [],
    callMethod: "",
    callParams: "{}",
    callResult: null,
    callError: null,
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onRefresh: () => undefined,
    onCall: () => undefined,
    ...overrides,
  };
}

function normalizedText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/gu, " ").trim();
}

describe("renderDebug", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await i18n.setLocale("en");
    vi.unstubAllGlobals();
  });

  it("keeps the security audit command styled as monospace", async () => {
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          status: {
            securityAudit: {
              summary: {
                critical: 0,
                warn: 1,
                info: 2,
              },
            },
          },
        }),
      ),
      container,
    );

    const command = container.querySelector<HTMLElement>(".settings-row__desc .mono");
    if (!command) {
      throw new Error("expected debug security audit command");
    }
    const status = container.querySelector(".settings-status");
    expect(status?.className).toContain("settings-status--warn");
    expect(normalizedText(status)).toBe("1 个警告 · 2 条信息");
    expect(command.textContent).toBe("openclaw security audit --deep");
  });

  it("does not render Invalid Date for Date-invalid event timestamps", () => {
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          eventLog: [
            {
              ts: 8_640_000_000_000_001,
              event: "gateway",
              payload: { ok: true },
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("gateway");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it.each([
    { label: "response", staleError: false },
    { label: "error", staleError: true },
  ])(
    "ignores an older manual RPC $label after the latest call succeeds",
    async ({ staleError }) => {
      const older = deferred<unknown>();
      const latest = deferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "manual.first") {
          return older.promise;
        }
        if (method === "manual.latest") {
          return latest.promise;
        }
        return diagnosticResponse(method);
      });
      const page = await mountDebugPage(request);

      page.debugCallMethod = "manual.first";
      await page.updateComplete;
      clickManualCall(page);
      page.debugCallMethod = "manual.latest";
      await page.updateComplete;
      clickManualCall(page);
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("manual.latest", {}));

      latest.resolve({ result: "latest response" });
      await vi.waitFor(() => expect(page.textContent).toContain("latest response"));
      if (staleError) {
        older.reject(new Error("stale manual failure"));
      } else {
        older.resolve({ result: "stale response" });
      }
      await older.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      await page.updateComplete;

      expect(page.textContent).toContain("latest response");
      expect(page.textContent).not.toContain("stale response");
      expect(page.textContent).not.toContain("stale manual failure");
      expect(page.debugCallError).toBeNull();
    },
  );

  it("reports polling failures separately from manual RPC and clears them on recovery", async () => {
    let diagnosticsUnavailable = false;
    const request = vi.fn(async (method: string) => {
      if (method === "manual.latest") {
        return { result: "manual response" };
      }
      if (method === "status" && diagnosticsUnavailable) {
        throw new Error("background snapshots unavailable");
      }
      return diagnosticResponse(method);
    });
    const page = await mountDebugPage(request);
    page.debugCallMethod = "manual.latest";
    await page.updateComplete;
    clickManualCall(page);
    await vi.waitFor(() => expect(page.textContent).toContain("manual response"));

    diagnosticsUnavailable = true;
    await page.loadDiagnostics();
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "background snapshots unavailable",
    );
    expect(page.textContent).not.toContain("Call failed");
    expect(page.debugCallError).toBeNull();
    expect(page.debugCallResult).toContain("manual response");

    diagnosticsUnavailable = false;
    await page.loadDiagnostics();
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.textContent).toContain("manual response");
  });

  it("clears a failed snapshots alert when the Gateway source changes", async () => {
    let diagnosticsUnavailable = false;
    const initialRequest = vi.fn(async (method: string) => {
      if (method === "status" && diagnosticsUnavailable) {
        throw new Error("old Gateway snapshots unavailable");
      }
      return diagnosticResponse(method);
    });
    const page = await mountDebugPage(initialRequest);
    diagnosticsUnavailable = true;
    await page.loadDiagnostics();
    await page.updateComplete;
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "old Gateway snapshots unavailable",
    );

    const nextStatus = deferred<unknown>();
    const nextRequest = vi.fn(async (method: string) =>
      method === "status" ? nextStatus.promise : diagnosticResponse(method),
    );
    const nextClient = { request: nextRequest } as unknown as GatewayBrowserClient;
    const nextGateway = {
      ...page.context.gateway,
      snapshot: { ...page.context.gateway.snapshot, client: nextClient },
      subscribe: () => () => undefined,
      subscribeEventLog: () => () => undefined,
    } as ApplicationContext["gateway"];
    page.context = { basePath: "", gateway: nextGateway } as ApplicationContext;
    page.requestUpdate();
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')).toBeNull();
    nextStatus.resolve({ version: "replacement" });
    await vi.waitFor(() => expect(page.debugStatus).toEqual({ version: "replacement" }));
  });
});
