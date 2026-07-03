import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { audioQueue, AudioFileJob } from "../../queue";

interface IngestBody {
  audioData: string;
  filename: string;
  mimeType?: string;
  sessionId?: string;
}

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IngestBody }>(
    "/ingest",
    {
      schema: {
        body: {
          type: "object",
          required: ["audioData", "filename"],
          properties: {
            audioData: { type: "string", minLength: 1 },
            filename:  { type: "string", minLength: 1 },
            mimeType:  { type: "string" },
            sessionId: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: IngestBody }>, reply: FastifyReply) => {
      const { audioData, filename, mimeType, sessionId } = req.body;
      const resolvedSessionId = sessionId || uuidv4();
      const jobData: AudioFileJob = { jobId: resolvedSessionId, audioData, filename, mimeType: mimeType || "audio/m4a" };
      await audioQueue.add("transcribe", jobData, { jobId: resolvedSessionId });
      app.log.info("[Ingest] Queued: " + filename + " | session: " + resolvedSessionId);
      return reply.status(202).send({ jobId: resolvedSessionId, sessionId: resolvedSessionId, status: "queued", queuedAt: new Date().toISOString() });
    }
  );
  app.get("/ingest/status", async (_req, reply) => {
    const [waiting, active, completed, failed] = await Promise.all([
      audioQueue.getWaitingCount(), audioQueue.getActiveCount(),
      audioQueue.getCompletedCount(), audioQueue.getFailedCount(),
    ]);
    return reply.send({ queue: "audio-files", waiting, active, completed, failed, timestamp: new Date().toISOString() });
  });
}
