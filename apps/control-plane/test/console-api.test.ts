import { describe, expect, it, vi } from "vitest";
import { ConsoleApiError, createConsoleApi } from "../web/api.js";

describe("console API client", () => {
  it("uses same-origin cookie credentials and decodes JSON", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ overview: { runnerCount: 2 } }),
    );
    const api = createConsoleApi(fetchImplementation);

    await expect(api.overview()).resolves.toEqual({ runnerCount: 2 });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/console/overview",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("loads the derived Agent Presence projection with same-origin credentials", async () => {
    const presence = {
      state: "available",
      reason: "Slack, Project Target, Runner, and fresh readiness are available.",
      agents: [],
    };
    const fetchImplementation = vi.fn(async () => Response.json({ presence }));
    const api = createConsoleApi(fetchImplementation);

    await expect(api.presence()).resolves.toEqual(presence);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/console/presence",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("surfaces closed server error codes without leaking response bodies", async () => {
    const api = createConsoleApi(async () =>
      Response.json({ error: "invalid_session", detail: "do not expose" }, { status: 401 }),
    );

    await expect(api.overview()).rejects.toEqual(
      new ConsoleApiError("invalid_session", 401),
    );
  });

  it("loads governed permission and material-action evidence together", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({
      materialActions: [{ receiptId: "receipt_1" }],
      permissions: [{ permissionRequestId: "permission_1" }],
    }));
    const api = createConsoleApi(fetchImplementation);

    await expect(api.evidence()).resolves.toEqual({
      materialActions: [{ receiptId: "receipt_1" }],
      permissions: [{ permissionRequestId: "permission_1" }],
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/console/evidence",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});
