import { MongoMemoryServer } from "mongodb-memory-server";

let server: MongoMemoryServer | undefined;

export async function setup(): Promise<void> {
  server = await MongoMemoryServer.create({ binary: { version: "8.2.6" } });
  process.env.TEST_MONGO_URI = server.getUri();
}

export async function teardown(): Promise<void> {
  await server?.stop();
}
