import { z } from "zod";

const plate = z.string().trim().min(2).max(12).transform((s) => s.toUpperCase());

export const vehicleCreate = z.strictObject({
  plate,
  make: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(40),
  year: z.number().int().min(1950).max(2100),
});

export const vehiclePatch = vehicleCreate.partial().refine((v) => Object.keys(v).length > 0, {
  message: "send at least one field",
});

export const recordCreate = z.strictObject({
  date: z.iso.date(),
  type: z.enum(["service", "repair", "inspection", "tyres", "fuel"]),
  odometerKm: z.number().int().min(0).max(5_000_000),
  costPence: z.number().int().min(0).max(100_000_000),
  notes: z.string().trim().max(1000).default(""),
});

export const recordPatch = recordCreate.partial().refine((v) => Object.keys(v).length > 0, {
  message: "send at least one field",
});

const limit = z.coerce.number().int().min(1).max(100).default(20);

export const listQuery = z.strictObject({
  limit,
  cursor: z.string().optional(),
  vehicleId: z.string().regex(/^[0-9a-f]{24}$/, "not a vehicle id").optional(),
  type: z.enum(["service", "repair", "inspection", "tyres", "fuel"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const vehicleListQuery = z.strictObject({
  limit,
  cursor: z.string().optional(),
});

export const reportQuery = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
});

export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
