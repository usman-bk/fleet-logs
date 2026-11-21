import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { car, rec, start, type Caller, type Harness } from "./harness.ts";

let h: Harness;
let a: Caller;
let b: Caller;
let vehicleA: string;
let recordA: string;

beforeAll(async () => {
  h = await start();
  a = (await h.tenant("Acme Haulage")).call;
  b = (await h.tenant("Birch Couriers")).call;
  vehicleA = (await a("POST", "/api/vehicles", car("AA11 AAA"))).body.id;
  recordA = (await a("POST", `/api/vehicles/${vehicleA}/records`, rec())).body.id;
  await b("POST", "/api/vehicles", car("BB22 BBB"));
});
afterAll(async () => {
  await h.close();
});

describe("authentication", () => {
  it("answers 401 with no key", async () => {
    expect((await h.anon("GET", "/api/vehicles")).status).toBe(401);
  });

  it("answers 401 for a key nobody holds", async () => {
    const res = await fetch(`${h.base}/api/vehicles`, { headers: { authorization: "Bearer fl_made_up" } });
    expect(res.status).toBe(401);
  });

  it("answers 401 for a malformed authorization header", async () => {
    const res = await fetch(`${h.base}/api/vehicles`, { headers: { authorization: "Basic abc" } });
    expect(res.status).toBe(401);
  });

  it("stores only a hash of the key", async () => {
    const t = await h.tenant("Hash check");
    const row = await h.c.tenants.findOne({ _id: t.id });
    expect(JSON.stringify(row)).not.toContain(t.key);
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tenant B against tenant A's ids", () => {
  const cases: [string, string, () => string, unknown?][] = [
    ["GET", "vehicle", () => `/api/vehicles/${vehicleA}`],
    ["PATCH", "vehicle", () => `/api/vehicles/${vehicleA}`, { make: "Hijacked" }],
    ["DELETE", "vehicle", () => `/api/vehicles/${vehicleA}`],
    ["POST", "a record on A's vehicle", () => `/api/vehicles/${vehicleA}/records`, rec()],
    ["GET", "record", () => `/api/records/${recordA}`],
    ["PATCH", "record", () => `/api/records/${recordA}`, { costPence: 1 }],
    ["DELETE", "record", () => `/api/records/${recordA}`],
  ];

  for (const [method, what, path, body] of cases) {
    it(`${method} ${what} answers 404`, async () => {
      const r = await b(method, path(), body);
      expect(r.status).toBe(404);
    });
  }

  it("left A's data untouched after every attempt above", async () => {
    const v = await a("GET", `/api/vehicles/${vehicleA}`);
    expect(v.body.make).toBe("Ford");
    const r = await a("GET", `/api/records/${recordA}`);
    expect(r.body.costPence).toBe(15000);
    expect(await h.c.records.countDocuments({ vehicleId: new (await import("mongodb")).ObjectId(vehicleA) })).toBe(1);
  });

  it("lists only B's vehicles", async () => {
    const r = await b("GET", "/api/vehicles");
    expect(r.body.items.map((v: { plate: string }) => v.plate)).toEqual(["BB22 BBB"]);
  });

  it("lists none of A's records, even when asked for A's vehicle by id", async () => {
    expect((await b("GET", "/api/records")).body.items).toEqual([]);
    expect((await b("GET", `/api/records?vehicleId=${vehicleA}`)).body.items).toEqual([]);
  });

  it("reports nothing of A's spending", async () => {
    const r = await b("GET", "/api/reports/cost-by-vehicle-month?from=2026-01-01&to=2026-12-31");
    expect(r.body.rows).toEqual([]);
  });

  it("cannot be told a tenant id in the body", async () => {
    const r = await b("POST", "/api/vehicles", { ...car("BB33 BBB"), tenantId: "000000000000000000000000" });
    expect(r.status).toBe(400);
    expect(r.body.errors.tenantId).toBeDefined();
  });

  it("cannot move a record to another tenant by patching a tenant id", async () => {
    const mine = (await b("GET", "/api/vehicles")).body.items[0].id;
    const made = await b("POST", `/api/vehicles/${mine}/records`, rec());
    const r = await b("PATCH", `/api/records/${made.body.id}`, { tenantId: "000000000000000000000000", vehicleId: vehicleA });
    expect(r.status).toBe(400);
  });
});

describe("the same plate in two fleets", () => {
  it("is allowed, and each fleet sees its own", async () => {
    const one = await a("POST", "/api/vehicles", car("SH4 RED"));
    const two = await b("POST", "/api/vehicles", car("SH4 RED"));
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(one.body.id).not.toBe(two.body.id);
  });

  it("is refused inside one fleet with a 409", async () => {
    const again = await a("POST", "/api/vehicles", car("SH4 RED"));
    expect(again.status).toBe(409);
  });
});
