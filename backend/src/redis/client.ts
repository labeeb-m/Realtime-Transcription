import Redis from "ioredis";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
// export const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: true });
export const redis = new Redis(REDIS_URL, {
  tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
});
export function createSubscriber(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });
}
redis.on("error", (err) => console.error("[Redis] Error:", err.message));
redis.on("connect", () => console.log("[Redis] Connected"));
