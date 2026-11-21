import { ObjectId } from "mongodb";

export interface Cursor {
  date: Date;
  id: ObjectId;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.date.getTime()}.${c.id.toHexString()}`).toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const m = /^(-?\d+)\.([0-9a-f]{24})$/.exec(text);
  if (!m) return null;
  const date = new Date(Number(m[1]));
  if (Number.isNaN(date.getTime())) return null;
  return { date, id: new ObjectId(m[2]) };
}

/**
 * Records are read newest first by (date, _id). "After the cursor" is a strict
 * comparison on that pair, so a record inserted while someone is paging can
 * only appear on pages that come after where it sorts. It never shifts the
 * rows already read, which is what skipping by offset gets wrong.
 */
export function afterCursor(c: Cursor) {
  return { $or: [{ date: { $lt: c.date } }, { date: c.date, _id: { $lt: c.id } }] };
}
