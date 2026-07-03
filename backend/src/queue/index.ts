import { Queue, QueueEvents } from "bullmq";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const url = new URL(REDIS_URL);
const connection = { host: url.hostname, port: parseInt(url.port || "6379", 10) };
export const QUEUE_NAME = "audio-files";
export interface AudioFileJob {
  jobId: string;
  audioData: string;
  filename: string;
  mimeType: string;
}
export const audioQueue = new Queue<AudioFileJob>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});
export const queueEvents = new QueueEvents(QUEUE_NAME, { connection });
queueEvents.on("completed", ({ jobId }) => console.log("[Queue] Job " + jobId + " completed"));
queueEvents.on("failed", ({ jobId, failedReason }) => console.error("[Queue] Job " + jobId + " failed: " + failedReason));
