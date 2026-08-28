import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAuditById, getIssuesByAudit } = vi.hoisted(() => ({
  getAuditById: vi.fn(),
  getIssuesByAudit: vi.fn(),
}));

vi.mock("@ally-fix/db", () => ({ getAuditById, getIssuesByAudit }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

import { GET } from "./route";

const audit = { id: "a-1", url: "https://example.com/", status: "completed", score: 42 };
const issues = [{ id: "i-1", auditId: "a-1", ruleId: "image-alt" }];

function get(id: string): Parameters<typeof GET> {
  return [
    new Request(`http://localhost:3000/api/audits/${id}`),
    { params: Promise.resolve({ id }) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuditById.mockResolvedValue(audit);
  getIssuesByAudit.mockResolvedValue(issues);
});

describe("GET /api/audits/:id", () => {
  it("returns the audit with its issues", async () => {
    const response = await GET(...get("a-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ audit, issues });
  });

  it("404s for an unknown id", async () => {
    getAuditById.mockResolvedValue(undefined);

    const response = await GET(...get("missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Audit not found." });
  });

  it("still 404s when the audit is missing but stray issues come back", async () => {
    // The two reads are independent; the audit's absence has to win.
    getAuditById.mockResolvedValue(undefined);
    getIssuesByAudit.mockResolvedValue(issues);

    const response = await GET(...get("missing"));

    expect(response.status).toBe(404);
  });

  it("returns an empty issue list for a clean page rather than 404ing", async () => {
    getIssuesByAudit.mockResolvedValue([]);

    const response = await GET(...get("a-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ issues: [] });
  });

  it("awaits the params promise and queries with the resolved id", async () => {
    await GET(...get("a-1"));

    expect(getAuditById).toHaveBeenCalledWith(expect.anything(), "a-1");
    expect(getIssuesByAudit).toHaveBeenCalledWith(expect.anything(), "a-1");
  });

  it("issues both reads concurrently — this endpoint is polled every 2s", async () => {
    let auditStarted = false;
    let issuesStartedBeforeAuditResolved = false;
    getAuditById.mockImplementation(async () => {
      auditStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return audit;
    });
    getIssuesByAudit.mockImplementation(async () => {
      if (auditStarted) issuesStartedBeforeAuditResolved = true;
      return issues;
    });

    await GET(...get("a-1"));

    expect(issuesStartedBeforeAuditResolved).toBe(true);
  });
});
