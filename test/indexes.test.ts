import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { start, type Harness } from "./harness.ts";

let h: Harness;
let tenantId: ObjectId;
let vehicleId: ObjectId;

beforeAll(async () => {
  h = await start();
  const t = await h.tenant("Plans Ltd");
  tenantId = t.id;
  vehicleId = new ObjectId();
  // Another tenant's rows make a scan of the whole collection visibly wrong.
  const other = await h.tenant("Noise Ltd");
  const rows = (tid: ObjectId, vid: ObjectId, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      _id: new ObjectId(),
      tenantId: tid,
      vehicleId: vid,
      date: new Date(Date.UTC(2026, i % 12, 1 + (i % 28))),
      type: "service" as const,
      odometerKm: i,
      costPence: 100,
      notes: "",
      createdAt: new Date(),
    }));
  await h.c.records.insertMany([...rows(tenantId, vehicleId, 400), ...rows(other.id, new ObjectId(), 1600)]);
});
afterAll(async () => {
  await h.close();
});

/** Every stage name in the winning plan, however deeply nested. */
function stages(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (typeof node.stage === "string") out.push(node.stage);
  for (const v of Object.values(node)) if (typeof v === "object") stages(v, out);
  return out;
}

async function plan(filter: object, sort: object) {
  const e: any = await h.c.records.find(filter).sort(sort as never).limit(21).explain("executionStats");
  return { stages: stages(e.queryPlanner.winningPlan), stats: e.executionStats };
}

describe("hot queries use an index", () => {
  it("lists a tenant's records newest first with IXSCAN and no sort stage", async () => {
    const p = await plan({ tenantId }, { date: -1, _id: -1 });
    expect(p.stages).toContain("IXSCAN");
    expect(p.stages).not.toContain("COLLSCAN");
    expect(p.stages).not.toContain("SORT");
  });

  it("lists one vehicle's history with IXSCAN and no sort stage", async () => {
    const p = await plan({ tenantId, vehicleId }, { date: -1, _id: -1 });
    expect(p.stages).toContain("IXSCAN");
    expect(p.stages).not.toContain("COLLSCAN");
    expect(p.stages).not.toContain("SORT");
  });

  it("reads only about a page of keys, not the tenant's 400 rows", async () => {
    const p = await plan({ tenantId }, { date: -1, _id: -1 });
    expect(p.stats.totalKeysExamined).toBeLessThanOrEqual(25);
    expect(p.stats.totalDocsExamined).toBeLessThanOrEqual(25);
  });

  it("keeps using the index with a cursor condition on the end", async () => {
    const date = new Date(Date.UTC(2026, 5, 10));
    const p = await plan(
      { tenantId, $and: [{ $or: [{ date: { $lt: date } }, { date, _id: { $lt: new ObjectId() } }] }] },
      { date: -1, _id: -1 },
    );
    expect(p.stages).toContain("IXSCAN");
    expect(p.stages).not.toContain("COLLSCAN");
  });

  it("serves the report's date range from an index", async () => {
    const e: any = await h.c.records
      .aggregate([{ $match: { tenantId, date: { $gte: new Date("2026-01-01"), $lte: new Date("2026-12-31") } } }])
      .explain("queryPlanner");
    const text = JSON.stringify(e);
    expect(text).toContain("IXSCAN");
    expect(text).not.toContain("COLLSCAN");
  });

  it("serves the vehicle listing by plate from the unique index", async () => {
    const e: any = await h.c.vehicles.find({ tenantId, plate: { $gt: "A" } }).sort({ plate: 1 }).limit(21).explain("queryPlanner");
    const s = stages(e.queryPlanner.winningPlan);
    expect(s).toContain("IXSCAN");
    expect(s).not.toContain("SORT");
  });

  it("serves the API-key lookup from the keyHash index", async () => {
    const e: any = await h.c.tenants.find({ keyHash: "abc" }).explain("queryPlanner");
    // MongoDB 8 plans a unique-key lookup as EXPRESS_IXSCAN, still an index read.
    const s = stages(e.queryPlanner.winningPlan);
    expect(s.some((x) => x.endsWith("IXSCAN"))).toBe(true);
    expect(s).not.toContain("COLLSCAN");
  });

  it("would scan without the index: a query on an unindexed field is a COLLSCAN", async () => {
    const e: any = await h.c.records.find({ notes: "nothing" }).explain("queryPlanner");
    expect(stages(e.queryPlanner.winningPlan)).toContain("COLLSCAN");
  });
});
