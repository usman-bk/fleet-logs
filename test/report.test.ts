import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { car, rec, start, type Caller, type Harness } from "./harness.ts";

let h: Harness;
let t: Caller;
let v1: string;
let v2: string;

const add = (vid: string, date: string, costPence: number) =>
  t("POST", `/api/vehicles/${vid}/records`, rec({ date, costPence }));

beforeAll(async () => {
  h = await start();
  t = (await h.tenant("Report Ltd")).call;
  v1 = (await t("POST", "/api/vehicles", car("AA1 AAA"))).body.id;
  v2 = (await t("POST", "/api/vehicles", car("BB2 BBB"))).body.id;
  await t("POST", "/api/vehicles", car("CC3 CCC"));
  // AA1: Jan 15000 + 7550, Feb 20000, Mar 4999, Apr 60000
  await add(v1, "2026-01-05", 15000);
  await add(v1, "2026-01-31", 7550);
  await add(v1, "2026-02-01", 20000);
  await add(v1, "2026-03-15", 4999);
  await add(v1, "2026-04-20", 60000);
  // BB2: Jan 1000, Feb 12345 + 5, Mar 777 on the last day of the range, Apr 300
  await add(v2, "2026-01-31", 1000);
  await add(v2, "2026-02-14", 12345);
  await add(v2, "2026-02-14", 5);
  await add(v2, "2026-03-31", 777);
  await add(v2, "2026-04-01", 300);
});
afterAll(async () => {
  await h.close();
});

const report = (from: string, to: string) =>
  t("GET", `/api/reports/cost-by-vehicle-month?from=${from}&to=${to}`);

describe("cost per vehicle per month", () => {
  it("matches the hand-computed table for January to March", async () => {
    const r = await report("2026-01-01", "2026-03-31");
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: any) => ({ plate: x.plate, month: x.month, totalPence: x.totalPence, records: x.records }))).toEqual([
      { plate: "AA1 AAA", month: "2026-01", totalPence: 22550, records: 2 },
      { plate: "AA1 AAA", month: "2026-02", totalPence: 20000, records: 1 },
      { plate: "AA1 AAA", month: "2026-03", totalPence: 4999, records: 1 },
      { plate: "BB2 BBB", month: "2026-01", totalPence: 1000, records: 1 },
      { plate: "BB2 BBB", month: "2026-02", totalPence: 12350, records: 2 },
      { plate: "BB2 BBB", month: "2026-03", totalPence: 777, records: 1 },
    ]);
  });

  it("puts 31 January and 1 February in different months", async () => {
    const r = await report("2026-01-31", "2026-02-01");
    const aa = r.body.rows.filter((x: { plate: string }) => x.plate === "AA1 AAA");
    expect(aa.map((x: { month: string; totalPence: number }) => [x.month, x.totalPence])).toEqual([
      ["2026-01", 7550],
      ["2026-02", 20000],
    ]);
  });

  it("includes both end days of the range and excludes the day after", async () => {
    const r = await report("2026-03-31", "2026-03-31");
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0]).toMatchObject({ plate: "BB2 BBB", month: "2026-03", totalPence: 777 });
  });

  it("leaves out a vehicle with nothing in the range", async () => {
    const r = await report("2026-01-01", "2026-12-31");
    expect(r.body.rows.some((x: { plate: string }) => x.plate === "CC3 CCC")).toBe(false);
  });

  it("adds up to the sum of every record in the range", async () => {
    const r = await report("2026-01-01", "2026-04-30");
    const total = r.body.rows.reduce((n: number, x: { totalPence: number }) => n + x.totalPence, 0);
    expect(total).toBe(22550 + 20000 + 4999 + 60000 + 1000 + 12350 + 777 + 300);
  });

  it("returns whole numbers, with no fractions from the sum", async () => {
    const r = await report("2026-01-01", "2026-12-31");
    for (const row of r.body.rows) expect(Number.isInteger(row.totalPence)).toBe(true);
  });

  it("follows an edit to a record", async () => {
    const made = await add(v1, "2026-05-05", 100);
    await t("PATCH", `/api/records/${made.body.id}`, { costPence: 250, date: "2026-06-01" });
    const r = await report("2026-05-01", "2026-06-30");
    expect(r.body.rows).toEqual([expect.objectContaining({ plate: "AA1 AAA", month: "2026-06", totalPence: 250 })]);
  });

  it("follows a delete", async () => {
    const made = await add(v2, "2026-07-07", 4000);
    await t("DELETE", `/api/records/${made.body.id}`);
    expect((await report("2026-07-01", "2026-07-31")).body.rows).toEqual([]);
  });

  it("returns an empty list for a range with no records", async () => {
    expect((await report("2020-01-01", "2020-12-31")).body.rows).toEqual([]);
  });

  it("requires both dates and rejects bad ones", async () => {
    const r = await t("GET", "/api/reports/cost-by-vehicle-month?from=2026-13-01");
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.errors).sort()).toEqual(["from", "to"]);
  });
});
