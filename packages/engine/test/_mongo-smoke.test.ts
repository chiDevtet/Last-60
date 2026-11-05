import { test, expect } from "bun:test";
import mongoose from "mongoose";
import { startLocalReplSet } from "../src/testing/mongod";
test("replset + transactions work", async () => {
  const rs = await startLocalReplSet();
  const conn = await mongoose.createConnection(rs.uri).asPromise();
  const M = conn.model("T", new mongoose.Schema({ a: Number }));
  await M.createCollection();
  const s = await conn.startSession();
  await s.withTransaction(async () => { await M.create([{ a: 1 }], { session: s }); });
  await s.endSession();
  expect(await M.countDocuments()).toBe(1);
  await conn.close(); await rs.stop();
}, 300000);
