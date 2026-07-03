import { FastifyInstance, FastifyRequest } from "fastify";
import { createSubscriber } from "../../redis/client";

export interface TranscriptSegment {
  type: "segment" | "done" | "error";
  sessionId: string;
  chunkIndex?: number;
  text?: string;
  confidence?: number;
  timestamp?: number;
  processingMs?: number;
  error?: string;
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { sessionId: string } }>(
    "/stream/:sessionId",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
      const { sessionId } = req.params;
      const channel = "session:" + sessionId;
      const NL = String.fromCharCode(10);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": process.env.FRONTEND_URL || "http://localhost:3000",
      });
      reply.raw.write("event: connected" + NL + "data: " + JSON.stringify({ sessionId, channel }) + NL + NL);
      const subscriber = createSubscriber();
      let isDone = false;
      const cleanup = async () => {
        if (isDone) return;
        isDone = true;
        clearInterval(heartbeat);
        await subscriber.unsubscribe(channel);
        subscriber.disconnect();
        if (!reply.raw.destroyed) reply.raw.end();
        app.log.info("[Stream] SSE closed for session " + sessionId);
      };
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat" + NL + NL);
        else cleanup();
      }, 15000);
      await subscriber.subscribe(channel);
      subscriber.on("message", async (_ch: string, message: string) => {
        try {
          const seg: TranscriptSegment = JSON.parse(message);
          if (seg.type === "segment") reply.raw.write("event: segment" + NL + "data: " + message + NL + NL);
          else if (seg.type === "done") { reply.raw.write("event: done" + NL + "data: " + message + NL + NL); await cleanup(); }
          else if (seg.type === "error") { reply.raw.write("event: error" + NL + "data: " + message + NL + NL); await cleanup(); }
        } catch (err) { app.log.error("[Stream] Parse error: " + err); }
      });
      subscriber.on("error", async (err: Error) => {
        const msg = JSON.stringify({ type: "error", error: "Stream interrupted" });
        reply.raw.write("event: error" + NL + "data: " + msg + NL + NL);
        await cleanup();
      });
      req.raw.on("close", cleanup);
      req.raw.on("aborted", cleanup);
    }
  );
}
