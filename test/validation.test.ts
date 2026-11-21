import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { car, rec, start, type Caller, type Harness } from "./harness.ts";

let h: Harness;
let t: Caller;
let vid: string;

beforeAll(async () => {
  h = await start();
  t = (await h.tenant("Validation Ltd")).call;
  vid = (await t("POST", "/api/vehicles", car())).body.id;
});
afterAll(async () => {
  await h.close();
});

describe("vehicle bodies", () => {
  it("returns 201 and upper-cases the plate", async () => {
    const r = await t("POST", "/api/vehicles", car("xy99 zzz"));
    expect(r.status).toBe(201);
    expect(r.body.plate).toBe("XY99 ZZZ");
  });

  it("names every wrong field in one 400", async () => {
    const r = await t("POST", "/api/vehicles", { plate: "", make: 5, model: "", year: 1800 });
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.errors).sort()).toEqual(["make", "model", "plate", "year"]);
  });

  it("names a missing field", async () => {
    const r = await t("POST", "/api/vehicles", { plate: "ZZ1 AAA", make: "Ford", model: "Transit" });
    expect(r.status).toBe(400);
    expect(r.body.errors.year).toBeDefined();
  });

  it("refuses a year that is not a whole number", async () => {
    const r = await t("POST", "/api/vehicles", { ...car("ZZ2 AAA"), year: 2020.5 });
    expect(r.body.errors.year).toBeDefined();
  });

  it("refuses an empty patch", async () => {
    const r = await t("PATCH", `/api/vehicles/${vid}`, {});
    expect(r.status).toBe(400);
  });

  it("patches one field and leaves the rest", async () => {
    const r = await t("PATCH", `/api/vehicles/${vid}`, { model: "Custom" });
    expect(r.body).toMatchObject({ model: "Custom", make: "Ford", year: 2021 });
  });

  it("answers 400, not 500, for a body that is not JSON", async () => {
    const res = await fetch(`${h.base}/api/vehicles`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${(await h.tenant("x")).key}` },
      body: "{broken",
    });
    expect(res.status).toBe(400);
  });
});

describe("record bodies", () => {
  it("returns 201 with the date as a plain day", async () => {
    const r = await t("POST", `/api/vehicles/${vid}/records`, rec());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ date: "2026-03-10", costPence: 15000, type: "service" });
  });

  it("names each bad field with its own message", async () => {
    const r = await t("POST", `/api/vehicles/${vid}/records`, {
      date: "10/03/2026",
      type: "paint",
      odometerKm: -5,
      costPence: 12.5,
      notes: 4,
    });
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.errors).sort()).toEqual(["costPence", "date", "notes", "odometerKm", "type"]);
  });

  it("refuses a date that is not on the calendar", async () => {
    const r = await t("POST", `/api/vehicles/${vid}/records`, rec({ date: "2026-02-30" }));
    expect(r.status).toBe(400);
    expect(r.body.errors.date).toBeDefined();
  });

  it("refuses a cost sent as a string, which is how decimals sneak in", async () => {
    const r = await t("POST", `/api/vehicles/${vid}/records`, rec({ costPence: "150.00" }));
    expect(r.body.errors.costPence).toBeDefined();
  });

  it("defaults the notes to an empty string", async () => {
    const { notes: _n, ...noNotes } = rec();
    const r = await t("POST", `/api/vehicles/${vid}/records`, noNotes);
    expect(r.body.notes).toBe("");
  });

  it("validates the body before it looks for the vehicle", async () => {
    const r = await t("POST", "/api/vehicles/000000000000000000000000/records", { type: "x" });
    expect(r.status).toBe(400);
  });

  it("answers 404 for a vehicle id that is not an id", async () => {
    expect((await t("POST", "/api/vehicles/not-an-id/records", rec())).status).toBe(404);
  });

  it("patches the date and the cost together", async () => {
    const made = await t("POST", `/api/vehicles/${vid}/records`, rec());
    const r = await t("PATCH", `/api/records/${made.body.id}`, { date: "2026-04-01", costPence: 999 });
    expect(r.body).toMatchObject({ date: "2026-04-01", costPence: 999, type: "service" });
  });

  it("deletes a record and then answers 404 for it", async () => {
    const made = await t("POST", `/api/vehicles/${vid}/records`, rec());
    expect((await t("DELETE", `/api/records/${made.body.id}`)).status).toBe(204);
    expect((await t("GET", `/api/records/${made.body.id}`)).status).toBe(404);
  });

  it("removes a vehicle's records with the vehicle", async () => {
    const v = (await t("POST", "/api/vehicles", car("GO1 NER"))).body.id;
    const r = (await t("POST", `/api/vehicles/${v}/records`, rec())).body.id;
    expect((await t("DELETE", `/api/vehicles/${v}`)).status).toBe(204);
    expect((await t("GET", `/api/records/${r}`)).status).toBe(404);
  });
});

describe("list queries", () => {
  it("refuses a limit of 0 and a limit of 500", async () => {
    expect((await t("GET", "/api/records?limit=0")).body.errors.limit).toBeDefined();
    expect((await t("GET", "/api/records?limit=500")).body.errors.limit).toBeDefined();
  });

  it("refuses a cursor that did not come from this API", async () => {
    const r = await t("GET", "/api/records?cursor=garbage");
    expect(r.status).toBe(400);
    expect(r.body.errors.cursor).toBeDefined();
  });

  it("refuses an unknown query parameter", async () => {
    const r = await t("GET", "/api/records?colour=red");
    expect(r.body.errors.colour).toBeDefined();
  });

  it("refuses a vehicleId that is not an id", async () => {
    expect((await t("GET", "/api/records?vehicleId=abc")).body.errors.vehicleId).toBeDefined();
  });
});
