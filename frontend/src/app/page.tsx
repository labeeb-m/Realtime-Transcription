"use client";

import { useState, useRef, useCallback } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
const CHUNK_SIZE = 64 * 1024;

interface TranscriptSegment {
  type: "segment" | "done" | "error";
  sessionId: string;
  chunkIndex?: number;
  text?: string;
  confidence?: number;
  timestamp?: number;
  processingMs?: number;
  error?: string;
}
interface QueueStatus { waiting: number; active: number; completed: number; failed: number; }
type PipelineState = "idle" | "uploading" | "processing" | "done" | "error";

function genSessionId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }

const Logo = () => (
  <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-label="Pocket Pipeline">
    <rect width="30" height="30" rx="8" fill="#01696f"/>
    <rect x="7" y="10" width="16" height="2.2" rx="1.1" fill="white"/>
    <rect x="7" y="15" width="11" height="2.2" rx="1.1" fill="white" fillOpacity="0.65"/>
    <rect x="7" y="20" width="7" height="2.2" rx="1.1" fill="white" fillOpacity="0.35"/>
  </svg>
);

const Waveform = ({ color = "#01696f" }: { color?: string }) => (
  <div className="flex items-end gap-[3px] h-5">
    {[6,10,14,10,6,10,14].map((h,i) => (
      <span key={i} className="w-[3px] rounded-full animate-pulse-dot"
        style={{ height: h, background: color, animationDelay: `${i*0.1}s` }} />
    ))}
  </div>
);

const IconUpload = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);

const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const IconDownload = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<PipelineState>("idle");
  const [sessionId, setSessionId] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [progress, setProgress] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  async function fileToBase64(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(slice));
    }
    return btoa(binary);
  }

  const pollQueue = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/ingest/status`);
      if (r.ok) setQueueStatus(await r.json());
    } catch {}
  }, []);

  const openStream = useCallback((sid: string) => {
    const es = new EventSource(`${API_BASE}/api/stream/${sid}`);
    esRef.current = es;
    const interval = setInterval(pollQueue, 1500);
    es.addEventListener("segment", (e) => {
      const seg: TranscriptSegment = JSON.parse((e as MessageEvent).data);
      setSegments((prev) => [...prev, seg]);
      setTimeout(() => {
        transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
      }, 40);
    });
    es.addEventListener("done", () => { setState("done"); es.close(); clearInterval(interval); pollQueue(); });
    es.addEventListener("error", (e) => {
      const d = (e as MessageEvent).data;
      if (d) setError(JSON.parse(d).error || "Stream error");
      setState("error"); es.close(); clearInterval(interval);
    });
  }, [pollQueue]);

  const handleUpload = useCallback(async () => {
    if (!file) return;

    const sid = genSessionId();
    setSessionId(sid);
    setSegments([]);
    setError("");
    setProgress(0);
    setState("uploading");

    const base64 = await fileToBase64(file);

    setProgress(50);
    setTotalChunks(1);

    const res = await fetch(`${API_BASE}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioData: base64,
        filename: file.name,
        mimeType: file.type || "audio/m4a",
        sessionId: sid,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      setError(err.message || "Ingest failed");
      setState("error");
      return;
    }

    openStream(sid);
    setProgress(100);
    setState("processing");
  }, [file, openStream]);

  const handleReset = () => {
    esRef.current?.close();
    setFile(null); setSegments([]); setSessionId(""); setProgress(0);
    setTotalChunks(0); setQueueStatus(null); setError(""); setState("idle");
  };

  const words = segments.reduce((a, s) => a + (s.text?.split(" ").length ?? 0), 0);
  const avgConf = segments.length ? segments.reduce((a, s) => a + (s.confidence ?? 0), 0) / segments.length : 0;
  const avgMs = segments.length ? segments.reduce((a, s) => a + (s.processingMs ?? 0), 0) / segments.length : 0;

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-[#e8e6e1] flex flex-col">
      <header className="border-b border-white/[0.06] px-6 py-4 flex-shrink-0">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <p className="text-[13px] font-semibold tracking-tight leading-tight">Pocket Pipeline Demo</p>
              <p className="text-[11px] text-white/35 leading-tight mt-0.5">Audio ingestion &middot; Redis queue &middot; SSE streaming</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {state === "processing" && <Waveform />}
            {state === "done" && <span className="flex items-center gap-1.5 text-xs text-emerald-400"><IconCheck /> Complete</span>}
            <a href="https://github.com" target="_blank" rel="noopener noreferrer"
              className="text-xs text-white/30 hover:text-white/60 transition-colors font-mono">GitHub</a>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8 grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">

        {/* LEFT — Upload + controls */}
        <div className="flex flex-col gap-4">
          <div
            onClick={() => !file && document.getElementById("file-input")?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
            role="button" aria-label="Upload audio file"
            className={[
              "rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer select-none",
              dragOver ? "border-[#01696f] bg-[#01696f]/10" : "border-white/[0.08] hover:border-white/[0.16] bg-white/[0.015]",
              file ? "p-4" : "p-8",
            ].join(" ")}
          >
            <input id="file-input" type="file" className="hidden"
              accept="audio/*,video/*,.mp3,.wav,.m4a,.mp4,.webm,.ogg"
              onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
            {file ? (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#01696f]/15 flex items-center justify-center flex-shrink-0">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#01696f" strokeWidth="2">
                      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium truncate">{file.name}</p>
                    <p className="text-[11px] text-white/35 mt-0.5">{(file.size/1024).toFixed(1)} KB &middot; {Math.ceil(file.size/CHUNK_SIZE)} chunks</p>
                  </div>
                </div>
                {state === "idle" && (
                  <button onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    className="text-white/25 hover:text-white/60 transition-colors text-xl leading-none" aria-label="Remove">x</button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-2xl bg-white/[0.04] flex items-center justify-center text-white/30"><IconUpload /></div>
                <div>
                  <p className="text-[13px] font-medium">Drop audio file here</p>
                  <p className="text-[11px] text-white/35 mt-1">MP3, WAV, M4A, MP4, WebM</p>
                </div>
                <span className="text-xs text-[#01696f] font-medium">Browse files</span>
              </div>
            )}
          </div>

          {(state === "uploading" || state === "processing") && (
            <div className="animate-fade-in">
              <div className="flex justify-between text-[11px] text-white/40 mb-1.5">
                <span>{state === "uploading" ? "Chunking & queueing..." : "Chunks queued — transcribing"}</span>
                <span className="font-mono">{progress}%</span>
              </div>
              <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                <div className="h-full bg-[#01696f] rounded-full transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
              </div>
              {totalChunks > 0 && <p className="text-[11px] text-white/25 mt-1.5 font-mono">{totalChunks} x 64KB chunks</p>}
            </div>
          )}

          {(state === "idle" || state === "error") && (
            <button onClick={handleUpload} disabled={!file}
              className="w-full py-2.5 px-4 rounded-xl text-[13px] font-semibold transition-all duration-200 bg-[#01696f] hover:bg-[#0c4e54] active:bg-[#0f3638] disabled:opacity-25 disabled:cursor-not-allowed text-white">
              Start Pipeline
            </button>
          )}
          {state === "done" && (
            <button onClick={handleReset}
              className="w-full py-2.5 px-4 rounded-xl text-[13px] font-medium bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] transition-all duration-200">
              New Recording
            </button>
          )}
          {(state === "uploading" || state === "processing") && (
            <button disabled className="w-full py-2.5 px-4 rounded-xl text-[13px] font-medium bg-[#01696f]/15 text-[#01696f] cursor-not-allowed flex items-center justify-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-[#01696f] border-t-transparent rounded-full animate-spin" />
              Processing...
            </button>
          )}

          {error && <div className="rounded-xl bg-red-500/8 border border-red-500/20 px-3 py-2.5 text-xs text-red-400 animate-fade-in">{error}</div>}

          {sessionId && (
            <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] px-3 py-2.5">
              <p className="text-[10px] text-white/25 uppercase tracking-wider mb-1">Session</p>
              <p className="font-mono text-[11px] text-white/45 break-all">{sessionId}</p>
            </div>
          )}

          {queueStatus && (
            <div className="animate-fade-in rounded-2xl bg-white/[0.02] border border-white/[0.06] p-4">
              <p className="text-[10px] text-white/30 font-medium uppercase tracking-wider mb-3">Queue Status</p>
              <div className="grid grid-cols-2 gap-2">
                {([["Waiting", queueStatus.waiting, "text-amber-400"], ["Active", queueStatus.active, "text-blue-400"],
                   ["Done", queueStatus.completed, "text-emerald-400"], ["Failed", queueStatus.failed, "text-red-400"]] as [string, number, string][]).map(([label, value, color]) => (
                  <div key={label} className="bg-white/[0.03] rounded-xl px-3 py-2.5">
                    <p className={`text-xl font-semibold tabular-nums leading-tight ${color}`}>{value}</p>
                    <p className="text-[11px] text-white/30 mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] p-4">
            <p className="text-[10px] text-white/30 font-medium uppercase tracking-wider mb-3">Pipeline</p>
            <div className="space-y-2.5">
              {([["POST /api/ingest","BullMQ queue","#01696f"],["Worker x2","transcription","#3b82f6"],
                ["Redis Pub/Sub","publish segments","#a78bfa"],["GET /api/stream/:id","SSE to client","#34d399"]] as [string,string,string][]).map(([l,r,dot]) => (
                <div key={l} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dot }} />
                    <span className="font-mono text-[11px] text-white/60">{l}</span>
                  </div>
                  <span className="text-[11px] text-white/30">{r}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT — Live transcript */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">Live Transcript</h2>
            {segments.length > 0 && (
              <div className="flex items-center gap-4 text-[11px] text-white/35 font-mono">
                <span>{words} words</span>
                <span>{(avgConf * 100).toFixed(1)}% conf</span>
                <span>{avgMs.toFixed(0)}ms avg</span>
              </div>
            )}
          </div>

          <div ref={transcriptRef}
            className="flex-1 min-h-[500px] max-h-[580px] overflow-y-auto rounded-2xl bg-white/[0.015] border border-white/[0.06] p-5 scroll-smooth">
            {segments.length === 0 && state === "idle" && (
              <div className="h-full flex flex-col items-center justify-center gap-4 text-center select-none">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="opacity-[0.12]">
                  <rect x="8" y="14" width="32" height="4" rx="2" fill="currentColor"/>
                  <rect x="8" y="22" width="24" height="4" rx="2" fill="currentColor"/>
                  <rect x="8" y="30" width="16" height="4" rx="2" fill="currentColor"/>
                </svg>
                <div>
                  <p className="text-sm text-white/20">Transcript streams here in real time</p>
                  <p className="text-xs text-white/10 mt-1">Upload a file and hit Start Pipeline</p>
                </div>
              </div>
            )}
            {segments.length === 0 && (state === "uploading" || state === "processing") && (
              <div className="h-full flex items-center justify-center"><Waveform color="#01696f" /></div>
            )}
            <div className="space-y-0.5">
              {segments.map((seg, i) => (
                <div key={i} className="animate-slide-up group flex items-start gap-3 px-2 py-2 rounded-xl hover:bg-white/[0.03] transition-colors duration-150">
                  <span className="text-[10px] text-white/20 font-mono tabular-nums mt-[3px] w-5 text-right flex-shrink-0">{(seg.chunkIndex ?? i)+1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm leading-relaxed text-[#e2e0db]">{seg.text}</p>
                    <div className="flex items-center gap-3 mt-0.5 h-4 overflow-hidden opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                      <span className="text-[10px] text-white/20 font-mono">{((seg.confidence ?? 0)*100).toFixed(1)}%</span>
                      <span className="text-[10px] text-white/20 font-mono">{seg.processingMs}ms</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {state === "done" && segments.length > 0 && (
              <div className="animate-fade-in mt-5 pt-4 border-t border-white/[0.06] flex items-center gap-2 text-xs text-emerald-400">
                <IconCheck /><span>{segments.length} segments complete</span>
              </div>
            )}
          </div>

          {state === "done" && segments.length > 0 && (
            <button
              onClick={() => {
                const text = segments.map((s, i) => "[" + (i+1) + "] " + s.text).join("\n");
                const blob = new Blob([text], { type: "text/plain" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "transcript-" + sessionId + ".txt";
                a.click();
              }}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-[13px] font-medium bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] transition-all duration-200 text-white/50 hover:text-white/80 animate-fade-in">
              <IconDownload /> Export transcript (.txt)
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
