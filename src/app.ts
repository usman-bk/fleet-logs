import express, { type NextFunction, type Request, type Response } from "express";
import { MongoServerError, ObjectId, type Filter } from "mongodb";
import type { ZodType } from "zod";
import { afterCursor, decodeCursor, encodeCursor } from "./cursor.ts";
import {
  hashKey,
  type Collections,
  type MaintenanceRecord,
  type Vehicle,
} from "./db.ts";
import {
  fieldErrors,
  listQuery,
  recordCreate,
  recordPatch,
  reportQuery,
  vehicleCreate,
  vehicleListQuery,
  vehiclePatch,
} from "./schemas.ts";

declare module "express-serve-static-core" {
  interface Request {
    tenantId: ObjectId;
  }
}

class Invalid extends Error {
  constructor(readonly errors: Record<string, string>) {
    super("invalid request");
  }
}

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new Invalid(fieldErrors(r.error));
  return r.data;
}

const oid = (s: string): ObjectId | null => (/^[0-9a-f]{24}$/.test(s) ? new ObjectId(s) : null);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const vehicleOut = (v: Vehicle) => ({
  id: v._id.toHexString(),
  plate: v.plate,
  make: v.make,
  model: v.model,
  year: v.year,
});

const recordOut = (r: MaintenanceRecord) => ({
  id: r._id.toHexString(),
  vehicleId: r.vehicleId.toHexString(),
  date: r.date.toISOString().slice(0, 10),
  type: r.type,
  odometerKm: r.odometerKm,
  costPence: r.costPence,
  notes: r.notes,
});

export function createApp(c: Collections) {
  const app = express();
  app.use(express.json());

  // The tenant comes from the key and from nowhere else. Every handler below
  // reads req.tenantId and puts it in the filter of every query it runs.
  app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const tenant = key ? await c.tenants.findOne({ keyHash: hashKey(key) }) : null;
    if (!tenant) return void res.status(401).json({ error: "missing or unknown API key" });
    req.tenantId = tenant._id;
    next();
  });

  // ---- vehicles
  app.post("/api/vehicles", async (req, res) => {
    const body = parse(vehicleCreate, req.body);
    const doc: Vehicle = { _id: new ObjectId(), tenantId: req.tenantId, ...body };
    await c.vehicles.insertOne(doc);
    res.status(201).json(vehicleOut(doc));
  });

  app.get("/api/vehicles", async (req, res) => {
    const q = parse(vehicleListQuery, req.query);
    const filter: Filter<Vehicle> = { tenantId: req.tenantId };
    if (q.cursor) {
      const plate = Buffer.from(q.cursor, "base64url").toString("utf8");
      filter.plate = { $gt: plate };
    }
    const rows = await c.vehicles.find(filter).sort({ plate: 1 }).limit(q.limit + 1).toArray();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map(vehicleOut),
      nextCursor: rows.length > q.limit && last ? Buffer.from(last.plate).toString("base64url") : null,
    });
  });

  app.get("/api/vehicles/:id", async (req, res) => {
    const id = oid(req.params.id);
    const v = id && (await c.vehicles.findOne({ _id: id, tenantId: req.tenantId }));
    if (!v) return void res.status(404).json({ error: "not found" });
    res.json(vehicleOut(v));
  });

  app.patch("/api/vehicles/:id", async (req, res) => {
    const body = parse(vehiclePatch, req.body);
    const id = oid(req.params.id);
    const v =
      id &&
      (await c.vehicles.findOneAndUpdate(
        { _id: id, tenantId: req.tenantId },
        { $set: body },
        { returnDocument: "after" },
      ));
    if (!v) return void res.status(404).json({ error: "not found" });
    res.json(vehicleOut(v));
  });

  app.delete("/api/vehicles/:id", async (req, res) => {
    const id = oid(req.params.id);
    const gone = id && (await c.vehicles.findOneAndDelete({ _id: id, tenantId: req.tenantId }));
    if (!gone) return void res.status(404).json({ error: "not found" });
    await c.records.deleteMany({ tenantId: req.tenantId, vehicleId: gone._id });
    res.status(204).end();
  });

  // ---- records
  app.post("/api/vehicles/:id/records", async (req, res) => {
    const body = parse(recordCreate, req.body);
    const id = oid(req.params.id);
    const vehicle = id && (await c.vehicles.findOne({ _id: id, tenantId: req.tenantId }));
    if (!vehicle) return void res.status(404).json({ error: "not found" });
    const doc: MaintenanceRecord = {
      _id: new ObjectId(),
      tenantId: req.tenantId,
      vehicleId: vehicle._id,
      ...body,
      date: day(body.date),
      createdAt: new Date(),
    };
    await c.records.insertOne(doc);
    res.status(201).json(recordOut(doc));
  });

  app.get("/api/records", async (req, res) => {
    const q = parse(listQuery, req.query);
    const filter: Filter<MaintenanceRecord> = { tenantId: req.tenantId };
    if (q.vehicleId) filter.vehicleId = new ObjectId(q.vehicleId);
    if (q.type) filter.type = q.type;
    const and: Filter<MaintenanceRecord>[] = [];
    if (q.from) and.push({ date: { $gte: day(q.from) } });
    if (q.to) and.push({ date: { $lte: day(q.to) } });
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw new Invalid({ cursor: "not a cursor from this API" });
      and.push(afterCursor(cur));
    }
    if (and.length) filter.$and = and;
    const rows = await c.records
      .find(filter)
      .sort({ date: -1, _id: -1 })
      .limit(q.limit + 1)
      .toArray();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map(recordOut),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ date: last.date, id: last._id }) : null,
    });
  });

  app.get("/api/records/:id", async (req, res) => {
    const id = oid(req.params.id);
    const r = id && (await c.records.findOne({ _id: id, tenantId: req.tenantId }));
    if (!r) return void res.status(404).json({ error: "not found" });
    res.json(recordOut(r));
  });

  app.patch("/api/records/:id", async (req, res) => {
    const body = parse(recordPatch, req.body);
    const { date, ...rest } = body;
    const set = date ? { ...rest, date: day(date) } : rest;
    const id = oid(req.params.id);
    const r =
      id &&
      (await c.records.findOneAndUpdate(
        { _id: id, tenantId: req.tenantId },
        { $set: set },
        { returnDocument: "after" },
      ));
    if (!r) return void res.status(404).json({ error: "not found" });
    res.json(recordOut(r));
  });

  app.delete("/api/records/:id", async (req, res) => {
    const id = oid(req.params.id);
    const r = id && (await c.records.findOneAndDelete({ _id: id, tenantId: req.tenantId }));
    if (!r) return void res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  // ---- report
  app.get("/api/reports/cost-by-vehicle-month", async (req, res) => {
    const q = parse(reportQuery, req.query);
    const rows = await c.records
      .aggregate([
        { $match: { tenantId: req.tenantId, date: { $gte: day(q.from), $lte: day(q.to) } } },
        {
          $group: {
            _id: { vehicleId: "$vehicleId", month: { $dateToString: { format: "%Y-%m", date: "$date", timezone: "UTC" } } },
            totalPence: { $sum: "$costPence" },
            records: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: "vehicles",
            let: { vid: "$_id.vehicleId", tid: req.tenantId },
            pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$_id", "$$vid"] }, { $eq: ["$tenantId", "$$tid"] }] } } }],
            as: "vehicle",
          },
        },
        { $unwind: "$vehicle" },
        {
          $project: {
            _id: 0,
            vehicleId: "$_id.vehicleId",
            plate: "$vehicle.plate",
            month: "$_id.month",
            totalPence: 1,
            records: 1,
          },
        },
        { $sort: { plate: 1, month: 1 } },
      ])
      .toArray();
    res.json({
      from: q.from,
      to: q.to,
      rows: rows.map((r) => ({ ...r, vehicleId: (r.vehicleId as ObjectId).toHexString() })),
    });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof Invalid) return void res.status(400).json({ errors: err.errors });
    if (err instanceof SyntaxError) return void res.status(400).json({ error: "body is not valid JSON" });
    if (err instanceof MongoServerError && err.code === 11000) {
      return void res.status(409).json({ error: "plate already exists for this fleet" });
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
