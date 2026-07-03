import Fastify from "fastify";
import cors from "@fastify/cors";
import { ingestRoutes } from "./routes/ingest";
import { streamRoutes } from "./routes/stream";
import { redis } from "../redis/client";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";

async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"], credentials: true });
  await app.register(ingestRoutes, { prefix: "/api" });
  await app.register(streamRoutes, { prefix: "/api" });
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
  return app;
}

async function start() {
  try {
    await redis.connect();
    const app = await buildApp();
    await app.listen({ port: PORT, host: HOST });
    console.log("API running at http://localhost:" + PORT);
    const shutdown = async (sig: string) => { await app.close(); await redis.quit(); process.exit(0); };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));
  } catch (err) { console.error("Failed to start:", err); process.exit(1); }
}

start();
