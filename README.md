# pocket-pipeline-demo

> Real-time audio ingestion, transcription, and SSE streaming pipeline.

Challenge: A hardware device streams audio continuously. That audio must be ingested reliably, transcribed with low latency, and pushed back to the client in real time. This project implements that full pipeline end-to-end using production-grade tooling.

---

## What It Does

Upload any audio file. The pipeline:

1. Encodes the file as base64 and sends it to `POST /api/ingest`
2. A BullMQ job is created and queued in Redis
3. A worker picks up the job, sends the audio to Deepgram (nova-2 model)
4. Deepgram returns a full transcript with paragraph/sentence segmentation
5. Each sentence is published to a Redis Pub/Sub channel
6. The frontend receives each sentence in real time via a persistent SSE connection

The result: a live transcript that streams in sentence-by-sentence as Deepgram processes the file, with per-sentence confidence scores and processing latency.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Next.js Frontend                         │
│  (file upload → base64 → POST /api/ingest)                      │
│  (EventSource → GET /api/stream/:sessionId)                     │
└────────────┬───────────────────────────┬────────────────────────┘
             │ POST /api/ingest          │ SSE stream
             ▼                           ▲
┌────────────────────────┐   ┌───────────────────────────────────┐
│  Fastify API Server    │   │  Redis Pub/Sub                    │
│  - validates request   │   │  channel: session:<sessionId>     │
│  - creates BullMQ job  │   │  subscriber per SSE client        │
│  - returns sessionId   │   └───────────────────────────────────┘
└────────────┬───────────┘                ▲
             │                            │ publish(segment)
             ▼                            │
┌────────────────────────────────────────────────────────────────┐
│  BullMQ Queue  (Redis-backed)                                   │
│  queue: audio-files | attempts: 2 | backoff: exponential       │
└────────────────────────────┬───────────────────────────────────┘
                             │
             ┌───────────────┴───────────────┐
             ▼                               ▼
┌────────────────────────┐   ┌───────────────────────────────────┐
│  Worker Instance 1     │   │  Worker Instance 2                │
│  concurrency: 3        │   │  concurrency: 3                   │
│  Deepgram nova-2       │   │  Deepgram nova-2                  │
└────────────────────────┘   └───────────────────────────────────┘
```

---

## Architecture Decisions

### Why send the full file instead of chunks?

M4A and most modern audio formats are container-based. Raw byte slices lack the file header needed for a decoder to understand the stream — Deepgram (and any transcription API) returns `corrupt or unsupported data` on partial chunks. The correct pattern for a demo of this architecture is: ingest the whole file as a single queued job, then stream the *output* (transcript segments) back incrementally. In production with a hardware device, you would use Deepgram's WebSocket streaming API and feed PCM directly from the device microphone — no chunking needed at the application layer.

### Why BullMQ over raw Redis lists?

Raw `RPUSH`/`BLPOP` is sufficient for basic queuing, but you lose everything that matters at scale: retries with exponential backoff, per-job progress tracking, concurrency controls, rate limiting (critical when hitting transcription API quotas), and dead-letter queues. BullMQ provides all of this on top of Redis with no additional infrastructure dependency.

### Why SSE over WebSockets?

Transcription results are unidirectional — server pushes segments to client, client never needs to respond. WebSockets introduce bidirectional complexity for no benefit here. SSE is HTTP/1.1-native, traverses proxies without configuration, and `EventSource` auto-reconnects on drop. The simpler primitive is always the right choice when it fits the problem.

### Why a dedicated Redis connection per SSE subscriber?

A Redis connection in subscribe mode cannot issue any other commands — it is fully consumed by the pub/sub protocol. Reusing the shared `redis` instance for subscribers would block all other Redis operations. Each SSE client gets its own `ioredis` subscriber instance that is explicitly disconnected when the client closes or the session completes.

### Why Fastify over Express?

Fastify's schema-based request validation (via `ajv`) rejects malformed payloads at the framework level before they reach handler logic. It also has measurably lower latency under concurrent load — relevant for an ingestion endpoint that may receive many uploads in parallel.

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| API server | Node.js + TypeScript + Fastify | Schema validation, low overhead, typed throughout |
| Queue | BullMQ on Redis | Retries, backoff, concurrency, DLQ — all on one Redis instance |
| Pub/Sub | Redis native | Zero-latency fanout from worker to SSE handler |
| Streaming | Server-Sent Events | Unidirectional push, HTTP-native, auto-reconnect |
| Transcription | Deepgram nova-2 | Fastest prerecorded model, paragraph/sentence segmentation |
| Frontend | Next.js 14 + Tailwind CSS | Fast iteration, no separate build pipeline |
| Infrastructure | Docker Compose | API + Worker (×2) + Redis, single command startup |

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Node.js 20+](https://nodejs.org/) for the frontend
- A free [Deepgram API key](https://console.deepgram.com/) (no credit card required — $200 free credit)

### 1. Add your Deepgram key

Open `docker-compose.yml` and set your key in both the `api` and `worker` service environment sections:

```yaml
environment:
  - DEEPGRAM_API_KEY=your_key_here
```

### 2. Start the backend

```bash
docker compose up --build
```

This starts three containers: `pocket-api` (port 3001), `pocket-worker` (×2 replicas), and `redis`.

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), drop in any audio file (M4A, MP3, WAV, WebM), and click **Start Pipeline**.

---

## API Reference

### `POST /api/ingest`

Queues an audio file for transcription.

**Request body:**
```json
{
  "audioData": "<base64-encoded audio>",
  "filename": "recording.m4a",
  "mimeType": "audio/m4a",
  "sessionId": "optional-custom-id"
}
```

**Response `202`:**
```json
{
  "jobId": "1782684587207-gsxtvb6",
  "sessionId": "1782684587207-gsxtvb6",
  "status": "queued",
  "queuedAt": "2026-06-28T22:00:00.000Z"
}
```

### `GET /api/stream/:sessionId`

Opens a persistent SSE connection. Emits three event types:

| Event | Payload |
|---|---|
| `connected` | `{ sessionId, channel }` |
| `segment` | `{ type, sessionId, chunkIndex, text, confidence, timestamp, processingMs }` |
| `done` | `{ type, sessionId, timestamp }` |
| `error` | `{ type, error }` |

### `GET /api/ingest/status`

Returns current queue depth: `waiting`, `active`, `completed`, `failed`.

---

## Scaling to Production

The current architecture scales horizontally with minimal changes:

- **Transcription**: swap `deepgram.listen.prerecorded` for `deepgram.listen.live` with a WebSocket stream from the device microphone — this eliminates the encode/decode overhead entirely and reduces first-word latency to under 300ms
- **Persistence**: write each segment to PostgreSQL as it arrives so clients can reconnect and replay missed segments
- **Rate limiting**: per-user `limiter` config in BullMQ (`{ max: N, duration: 1000 }`) prevents any single user from flooding the transcription queue
- **Worker autoscaling**: expose queue depth via `GET /api/ingest/status`, feed into AWS ECS / Kubernetes HPA to add worker replicas under load and remove them during idle periods
- **Audio compression**: on-device Opus encoding at 32kbps reduces upload bandwidth ~4× vs. raw PCM before the audio ever reaches the ingestion endpoint

---

## What's Not Implemented

Being explicit about scope:

- **Speaker diarization** — identifying which speaker said what (Deepgram supports this via `diarize: true`)
- **Stream reconnect/replay** — if the SSE connection drops mid-session, the client loses segments already published (requires a persistence layer)
- **Authentication** — no session ownership validation; any client can subscribe to any `sessionId`
- **Hardware device simulation** — the demo uses uploaded files; a real device would stream PCM over a persistent WebSocket

---

Built by **Labeeb Muntasir**
