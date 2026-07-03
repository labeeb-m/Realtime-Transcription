import { Worker, Job } from "bullmq";
import { createClient } from "@deepgram/sdk";
import { redis } from "../redis/client";
import { QUEUE_NAME, AudioFileJob } from "../queue";
import { TranscriptSegment } from "../api/routes/stream";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const url = new URL(REDIS_URL);
const connection = { host: url.hostname, port: parseInt(url.port || "6379", 10) };

const deepgram = createClient(process.env.DEEPGRAM_API_KEY || "");

async function publish(sessionId: string, segment: TranscriptSegment): Promise<void> {
  await redis.publish("session:" + sessionId, JSON.stringify(segment));
}

const worker = new Worker<AudioFileJob>(
  QUEUE_NAME,
  async (job: Job<AudioFileJob>) => {
    const { audioData, filename, mimeType } = job.data;
    const sessionId = job.id || job.data.jobId;
    console.log("[Worker] Transcribing: " + filename + " | session: " + sessionId);
    await job.updateProgress(10);
    const start = Date.now();
    const audioBuffer = Buffer.from(audioData, "base64");
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      { model: "nova-2", smart_format: true, punctuate: true, paragraphs: true, mimetype: mimeType || "audio/m4a" }
    );
    if (error) throw new Error(JSON.stringify(error));
    await job.updateProgress(70);
    const processingMs = Date.now() - start;
    const alt = result.results.channels[0].alternatives[0];
    const confidence = alt.confidence ?? 0.95;
    const sentences: string[] = alt.paragraphs?.paragraphs
      ?.flatMap((p: any) => p.sentences?.map((s: any) => s.text) ?? [])
      ?? alt.transcript.match(/[^.!?]+[.!?]+/g)
      ?? [alt.transcript];
    for (let i = 0; i < sentences.length; i++) {
      await publish(sessionId, { type: "segment", sessionId, chunkIndex: i, text: sentences[i].trim(), confidence, timestamp: Date.now(), processingMs: i === 0 ? processingMs : 0 });
    }
    await publish(sessionId, { type: "done", sessionId, timestamp: Date.now() });
    await job.updateProgress(100);
    console.log("[Worker] Done: " + sentences.length + " sentences in " + processingMs + "ms");
    return { sessionId, sentences: sentences.length, processingMs };
  },
  { connection, concurrency: 3 }
);

worker.on("ready", () => console.log("Worker ready"));
worker.on("failed", (job, err) => console.error("[Worker] Job " + job?.id + " failed: " + err.message));

const shutdown = async (sig: string) => {
  console.log("[Worker] " + sig + " - draining...");
  await worker.close(); await redis.quit(); process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
