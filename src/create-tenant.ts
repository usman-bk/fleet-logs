import { MongoClient } from "mongodb";
import { collections, createTenant, ensureIndexes } from "./db.ts";

const name = process.argv[2];
if (!name) {
  console.error('usage: npm run tenant -- "Fleet company name"');
  process.exit(2);
}
const client = new MongoClient(process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017");
await client.connect();
const c = collections(client.db(process.env.MONGO_DB ?? "fleetlogs"));
await ensureIndexes(c);
const { apiKey } = await createTenant(c, name);
console.log(`API key for ${name} (shown once): ${apiKey}`);
await client.close();
