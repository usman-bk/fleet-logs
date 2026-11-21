import { MongoClient } from "mongodb";
import { createApp } from "./app.ts";
import { collections, ensureIndexes } from "./db.ts";

const client = new MongoClient(process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017");
await client.connect();
const c = collections(client.db(process.env.MONGO_DB ?? "fleetlogs"));
await ensureIndexes(c);

const port = Number(process.env.PORT ?? 3000);
createApp(c).listen(port, () => console.log(`fleet-logs listening on ${port}`));
