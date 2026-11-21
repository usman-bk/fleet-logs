import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, type ObjectId } from "mongodb";
import { createApp } from "../src/app.ts";
import { collections, createTenant, ensureIndexes, type Collections } from "../src/db.ts";

let counter = 0;

export interface Reply {
  status: number;
  body: any;
}

export interface Harness {
  c: Collections;
  base: string;
  tenant: (name: string) => Promise<{ id: ObjectId; key: string; call: Caller }>;
  anon: Caller;
  close: () => Promise<void>;
}

export type Caller = (method: string, path: string, body?: unknown) => Promise<Reply>;

export async function start(): Promise<Harness> {
  const uri = process.env.TEST_MONGO_URI;
  if (!uri) throw new Error("TEST_MONGO_URI is not set, global setup did not run");
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(`fleet_test_${process.pid}_${counter++}`);
  const c = collections(db);
  await ensureIndexes(c);
  const server: Server = await new Promise((resolve) => {
    const s = createApp(c).listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const caller = (key?: string): Caller => async (method, path, body) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    c,
    base,
    anon: caller(),
    tenant: async (name) => {
      const t = await createTenant(c, name);
      return { id: t.id, key: t.apiKey, call: caller(t.apiKey) };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await db.dropDatabase();
      await client.close();
    },
  };
}

export const car = (plate = "AB12 CDE") => ({ plate, make: "Ford", model: "Transit", year: 2021 });
export const rec = (over: Record<string, unknown> = {}) => ({
  date: "2026-03-10",
  type: "service",
  odometerKm: 42000,
  costPence: 15000,
  notes: "oil and filters",
  ...over,
});
