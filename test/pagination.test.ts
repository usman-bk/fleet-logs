import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { car, rec, start, type Caller, type Harness } from "./harness.ts";

let h: Harness;
let t: Caller;
let tenantId: ObjectId;
let vid: string;

beforeAll(async () => {
  h = await start();
  const made = await h.tenant("Paging Ltd");
  t = made.call;
  tenantId = made.id;
  vid = (await t("POST", "/api/vehicles", car())).body.id;
  // 60 records over only 6 distinct dates, so ten share each date and the
  // date alone cannot order them.
  const docs = Array.from({ length: 60 }, (_, i) => ({
    _id: new ObjectId(),
    tenantId,
    vehicleId: new ObjectId(vid),
    date: new Date(Date.UTC(2026, 0, 1 + (i % 6))),
    type: "service" as const,
    odometerKm: i,
    costPence: 100,
    notes: "",
    createdAt: new Date(),
  }));
  await h.c.records.insertMany(docs);
});
afterAll(async () => {
  await h.close();
});

async function readAll(limit: number, between?: (page: number) => Promise<void>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const q: string = `/api/records?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
    const r = await t("GET", q);
    expect(r.status).toBe(200);
    ids.push(...r.body.items.map((i: { id: string }) => i.id));
    cursor = r.body.nextCursor;
    page++;
    if (between) await between(page);
  } while (cursor);
  return ids;
}

describe("cursor pagination", () => {
  it("reads all 60 records once each with a page size of 7", async () => {
    const ids = await readAll(7);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  });

  it("returns them newest date first, ties broken by id descending", async () => {
    const all = (await t("GET", "/api/records?limit=100")).body.items as { id: string; date: string }[];
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!;
      const cur = all[i]!;
      expect(prev.date >= cur.date).toBe(true);
      if (prev.date === cur.date) expect(prev.id > cur.id).toBe(true);
    }
  });

  it("gives the same order whatever the page size", async () => {
    const a = await readAll(7);
    const b = await readAll(25);
    const c = await readAll(100);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("sends no cursor on the last page, and none when the page is exactly full", async () => {
    const r = await t("GET", "/api/records?limit=100");
    expect(r.body.nextCursor).toBeNull();
    const exact = await t("GET", "/api/records?limit=60");
    expect(exact.body.items).toHaveLength(60);
    expect(exact.body.nextCursor).toBeNull();
  });

  it("neither skips nor repeats when newer rows arrive between pages", async () => {
    const before = (await t("GET", "/api/records?limit=100")).body.items.map((i: { id: string }) => i.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let n = 0;
    do {
      const r: any = await t("GET", `/api/records?limit=8${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.body.items.map((i: { id: string }) => i.id));
      cursor = r.body.nextCursor;
      n++;
      if (n === 2) {
        // Mid-scan: ten rows newer than everything, five that share the date
        // of the cursor, five older than everything.
        for (let i = 0; i < 10; i++) await t("POST", `/api/vehicles/${vid}/records`, rec({ date: "2026-06-01" }));
        for (let i = 0; i < 5; i++) await t("POST", `/api/vehicles/${vid}/records`, rec({ date: "2026-01-03" }));
        for (let i = 0; i < 5; i++) await t("POST", `/api/vehicles/${vid}/records`, rec({ date: "2025-01-01" }));
      }
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of before) expect(seen).toContain(id);
  });

  it("does not show a row inserted ahead of the cursor, and does not move the rows behind it", async () => {
    const first = await t("GET", "/api/records?limit=5&vehicleId=" + vid);
    const cursor = first.body.nextCursor;
    const nextBefore = (await t("GET", `/api/records?limit=5&cursor=${cursor}`)).body.items;
    await t("POST", `/api/vehicles/${vid}/records`, rec({ date: "2027-01-01" }));
    const nextAfter = (await t("GET", `/api/records?limit=5&cursor=${cursor}`)).body.items;
    expect(nextAfter).toEqual(nextBefore);
  });

  it("copes with a row deleted between pages", async () => {
    const p1 = await t("GET", "/api/records?limit=10");
    await t("DELETE", `/api/records/${p1.body.items[3].id}`);
    const p2 = await t("GET", `/api/records?limit=10&cursor=${p1.body.nextCursor}`);
    const ids1 = new Set(p1.body.items.map((i: { id: string }) => i.id));
    expect(p2.body.items.some((i: { id: string }) => ids1.has(i.id))).toBe(false);
    expect(p2.body.items).toHaveLength(10);
  });

  it("filters by type and date range and still pages", async () => {
    await t("POST", `/api/vehicles/${vid}/records`, rec({ type: "tyres", date: "2026-02-10" }));
    await t("POST", `/api/vehicles/${vid}/records`, rec({ type: "tyres", date: "2026-02-11" }));
    const r = await t("GET", "/api/records?type=tyres&from=2026-02-10&to=2026-02-10&limit=1");
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].date).toBe("2026-02-10");
    expect(r.body.nextCursor).toBeNull();
  });

  it("keeps a date range filter when paging with a cursor", async () => {
    const p1 = await t("GET", "/api/records?from=2026-01-02&to=2026-01-03&limit=4");
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await t("GET", `/api/records?from=2026-01-02&to=2026-01-03&limit=100&cursor=${p1.body.nextCursor}`);
    for (const i of [...p1.body.items, ...p2.body.items]) {
      expect(i.date >= "2026-01-02" && i.date <= "2026-01-03").toBe(true);
    }
  });
});

describe("vehicle pagination", () => {
  it("pages through vehicles by plate without repeats", async () => {
    for (const p of ["V1 AAA", "V2 AAA", "V3 AAA", "V4 AAA", "V5 AAA"]) await t("POST", "/api/vehicles", car(p));
    const got: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await t("GET", `/api/vehicles?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      got.push(...r.body.items.map((v: { plate: string }) => v.plate));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(got).toEqual([...got].sort());
    expect(new Set(got).size).toBe(got.length);
    expect(got).toHaveLength(6);
  });
});
