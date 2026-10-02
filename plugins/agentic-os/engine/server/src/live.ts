/**
 * One server-sent-events stream (/api/events) for the data every page shares, in
 * place of each tab polling it. Each topic is loaded once for all clients, on its
 * own cadence and when something calls refresh(); a client gets a topic's JSON only
 * when it differs from the last one sent. Nothing loads while nobody is connected.
 *
 * DASHBOARD_TIMINGS=1 logs how long each load took, and every 10 s the longest the
 * event loop was blocked (sync work that stalls every request).
 */
import type { ServerResponse } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

interface TopicState {
  load: () => unknown;
  everyMs: number;
  json: string | null;
  /** What "changed" is judged on: the JSON without a top-level `timestamp` (status and overview stamp every load). */
  key: string | null;
  inFlight: Promise<void> | null;
  again: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const PING_MS = 25000;

export class LiveHub {
  private topics = new Map<string, TopicState>();
  private clients = new Set<ServerResponse>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private timings = !!process.env.DASHBOARD_TIMINGS;

  constructor() {
    if (!this.timings) return;
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    setInterval(() => {
      console.log(`[live] event loop: max ${Math.round(lag.max / 1e6)}ms p99 ${Math.round(lag.percentile(99) / 1e6)}ms`);
      lag.reset();
    }, 10000).unref();
  }

  /** `everyMs` 0: loaded only when a client connects or refresh() is called. */
  register(name: string, load: () => unknown, everyMs: number): void {
    this.topics.set(name, { load, everyMs, json: null, key: null, inFlight: null, again: false, timer: null });
  }

  get clientCount(): number { return this.clients.size; }

  /** Send the last payloads right away (a fast first paint, maybe stale), then load every topic fresh. */
  subscribe(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    for (const [name, t] of this.topics) if (t.json !== null) res.write(frame(name, t.json));
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
      if (!this.clients.size) this.stop();
    });
    if (this.clients.size === 1) {
      this.ping = setInterval(() => { for (const c of this.clients) c.write(": ping\n\n"); }, PING_MS);
      for (const name of this.topics.keys()) this.refresh(name);
    }
  }

  /**
   * Load a topic now and send it if it changed. A call while a load is running
   * makes one more load after it, so a change that lands mid-load isn't missed.
   */
  refresh(name: string): Promise<void> {
    const t = this.topics.get(name);
    if (!t) return Promise.resolve();
    if (!this.clients.size) return Promise.resolve();
    if (t.inFlight) { t.again = true; return t.inFlight; }
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    const started = Date.now();
    t.inFlight = (async () => {
      try {
        const data = await t.load();
        const json = JSON.stringify(data);
        const key = data && typeof data === "object" && "timestamp" in data ? JSON.stringify({ ...data, timestamp: undefined }) : json;
        if (this.timings) console.log(`[live] ${name} ${Date.now() - started}ms ${json.length}B${key === t.key ? " (unchanged)" : ""}`);
        if (key !== t.key && this.clients.size) {
          t.json = json;
          t.key = key;
          this.broadcast(frame(name, json));
        }
      } catch (e) {
        if (this.timings) console.log(`[live] ${name} failed: ${(e as Error).message}`);
      } finally {
        t.inFlight = null;
        if (t.again) { t.again = false; this.refresh(name); }
        else this.schedule(name, t);
      }
    })();
    return t.inFlight;
  }

  /** Send a one-off event (not cached; a client that connects later gets the topic's next load). */
  publish(event: string, data: unknown): void {
    if (this.clients.size) this.broadcast(frame(event, JSON.stringify(data)));
  }

  private schedule(name: string, t: TopicState) {
    if (!t.everyMs || !this.clients.size || t.timer) return;
    t.timer = setTimeout(() => { t.timer = null; this.refresh(name); }, t.everyMs);
    t.timer.unref?.();
  }

  private broadcast(payload: string) {
    for (const c of this.clients) c.write(payload);
  }

  private stop() {
    if (this.ping) { clearInterval(this.ping); this.ping = null; }
    for (const t of this.topics.values()) {
      if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    }
  }
}

function frame(event: string, json: string): string {
  return `event: ${event}\ndata: ${json}\n\n`;
}
