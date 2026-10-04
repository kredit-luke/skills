/**
 * A small client for Ollama's HTTP API (https://docs.ollama.com/api): is it running, what's
 * downloaded, what a model can do, and download (with byte progress) or delete one.
 * The address is OLLAMA_HOST when set (as Ollama itself reads it), else 127.0.0.1:11434.
 */

import os from "node:os";
import path from "node:path";

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  digest: string;
  params: string | null;
  quantization: string | null;
  family: string | null;
  modifiedAt: string | null;
}

export interface OllamaShow {
  capabilities: string[];
  /** The model's own maximum context, from its metadata. */
  contextMax: number | null;
  /** num_ctx from its Modelfile parameters (what it runs with), or null for Ollama's default. */
  numCtx: number | null;
}

export interface PullProgress { status: string; completed: number; total: number }

/** OLLAMA_HOST ("0.0.0.0", "host:port", "http://host:port") → a base URL to call. */
export function ollamaBase(env: NodeJS.ProcessEnv = process.env): string {
  let h = String(env.OLLAMA_HOST || "").trim();
  if (!h) return "http://127.0.0.1:11434";
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  const u = new URL(h);
  // 0.0.0.0 is where a server listens, not an address to call.
  if (u.hostname === "0.0.0.0" || u.hostname === "[::]") u.hostname = "127.0.0.1";
  if (!u.port && u.protocol === "http:") u.port = "11434";
  return u.origin;
}

/** Where Ollama keeps models (OLLAMA_MODELS, else ~/.ollama/models), for the disk-space check. */
export function ollamaModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OLLAMA_MODELS || path.join(os.homedir(), ".ollama", "models");
}

export class Ollama {
  readonly base: string;
  constructor(base = ollamaBase()) { this.base = base; }

  private async call(p: string, init: RequestInit = {}, timeoutMs = 5000): Promise<any> {
    const r = await fetch(this.base + p, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs), headers: { "Content-Type": "application/json" } });
    const text = await r.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) throw new Error(data?.error || `Ollama answered ${r.status}`);
    return data;
  }

  /** The running server's version, or null when nothing answers. */
  async version(): Promise<string | null> {
    try { return (await this.call("/api/version", {}, 1500))?.version || null; } catch { return null; }
  }

  /**
   * Whether this Ollama serves Anthropic's Messages API (/v1/messages), which Claude Code needs
   * (newer versions only). Asked directly rather than by version: an empty request is a 400 where
   * it exists and a 404 where it doesn't.
   */
  async messagesApi(): Promise<boolean> {
    try {
      const r = await fetch(this.base + "/v1/messages", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(3000) });
      await r.text().catch(() => "");
      return r.status !== 404;
    } catch { return false; }
  }

  async list(): Promise<OllamaModel[]> {
    const d = await this.call("/api/tags");
    return (d?.models || []).map((m: any) => ({
      name: m.name || m.model,
      sizeBytes: Number(m.size) || 0,
      digest: m.digest || "",
      params: m.details?.parameter_size || null,
      quantization: m.details?.quantization_level || null,
      family: m.details?.family || null,
      modifiedAt: m.modified_at || null,
    }));
  }

  async show(model: string): Promise<OllamaShow> {
    return parseShow(await this.call("/api/show", { method: "POST", body: JSON.stringify({ model }) }, 15000));
  }

  /** Download a model, reporting progress as it goes. Resolves when it's done; rejects on an error or abort. */
  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const r = await fetch(this.base + "/api/pull", { method: "POST", body: JSON.stringify({ model, stream: true }), signal, headers: { "Content-Type": "application/json" } });
    if (!r.ok || !r.body) {
      let msg = `Ollama answered ${r.status}`;
      try { msg = JSON.parse(await r.text()).error || msg; } catch {}
      throw new Error(msg);
    }
    const layers = new Map<string, { completed: number; total: number }>();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        if (ev.status === "success") done = true;
        onProgress(pullStep(ev, layers));
      }
    }
    if (!done) throw new Error("The download stopped before it finished.");
  }

  async remove(model: string): Promise<void> {
    await this.call("/api/delete", { method: "DELETE", body: JSON.stringify({ model }) }, 30000);
  }

  /** A model that's `from` with other parameters (num_ctx): shares its files, so it takes no disk. */
  async derive(model: string, from: string, parameters: Record<string, unknown>): Promise<void> {
    await this.call("/api/create", { method: "POST", body: JSON.stringify({ model, from, parameters, stream: false }) }, 120000);
  }
}

/** One /api/pull line → overall progress (the layers' bytes added up). */
export function pullStep(ev: any, layers: Map<string, { completed: number; total: number }>): PullProgress {
  if (ev.digest && ev.total) layers.set(ev.digest, { completed: Number(ev.completed) || 0, total: Number(ev.total) || 0 });
  let completed = 0, total = 0;
  for (const l of layers.values()) { completed += l.completed; total += l.total; }
  return { status: String(ev.status || ""), completed, total };
}

export function parseShow(d: any): OllamaShow {
  const info = d?.model_info || {};
  const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
  const m = /^num_ctx\s+(\d+)/m.exec(String(d?.parameters || ""));
  return {
    capabilities: Array.isArray(d?.capabilities) ? d.capabilities.map(String) : [],
    contextMax: key ? Number(info[key]) || null : null,
    numCtx: m ? Number(m[1]) : null,
  };
}
