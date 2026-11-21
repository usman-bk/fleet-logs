import { createHash, randomBytes } from "node:crypto";
import { ObjectId, type Collection, type Db } from "mongodb";

export interface Tenant {
  _id: ObjectId;
  name: string;
  keyHash: string;
}

export interface Vehicle {
  _id: ObjectId;
  tenantId: ObjectId;
  plate: string;
  make: string;
  model: string;
  year: number;
}

export type RecordType = "service" | "repair" | "inspection" | "tyres" | "fuel";

export interface MaintenanceRecord {
  _id: ObjectId;
  tenantId: ObjectId;
  vehicleId: ObjectId;
  /** Service date, stored at UTC midnight. */
  date: Date;
  type: RecordType;
  odometerKm: number;
  /** Whole pence, never a float. */
  costPence: number;
  notes: string;
  createdAt: Date;
}

export interface Collections {
  tenants: Collection<Tenant>;
  vehicles: Collection<Vehicle>;
  records: Collection<MaintenanceRecord>;
}

export function collections(db: Db): Collections {
  return {
    tenants: db.collection<Tenant>("tenants"),
    vehicles: db.collection<Vehicle>("vehicles"),
    records: db.collection<MaintenanceRecord>("records"),
  };
}

/**
 * Every index leads with tenantId, because every query does. The two on
 * records are the ones the hot queries use: the tenant-wide listing and the
 * history of one vehicle, both newest first with _id as the tiebreak.
 */
export async function ensureIndexes(c: Collections): Promise<void> {
  await c.tenants.createIndex({ keyHash: 1 }, { unique: true });
  await c.vehicles.createIndex({ tenantId: 1, plate: 1 }, { unique: true });
  await c.records.createIndex({ tenantId: 1, date: -1, _id: -1 }, { name: "tenant_by_date" });
  await c.records.createIndex({ tenantId: 1, vehicleId: 1, date: -1, _id: -1 }, { name: "vehicle_by_date" });
}

export const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** Returns the API key once. Only its hash is stored. */
export async function createTenant(c: Collections, name: string): Promise<{ id: ObjectId; apiKey: string }> {
  const apiKey = `fl_${randomBytes(24).toString("base64url")}`;
  const _id = new ObjectId();
  await c.tenants.insertOne({ _id, name, keyHash: hashKey(apiKey) });
  return { id: _id, apiKey };
}
