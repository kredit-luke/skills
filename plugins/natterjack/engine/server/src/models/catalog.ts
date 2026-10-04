/**
 * The Models page's recommended open models: a short list of good choices for Claude Code
 * on a single computer, from small (any laptop) to large (a 24 GB GPU or a 32 GB Mac).
 * Open models change every month, so this is data, refreshed with each engine release from
 * ollama.com/library (sizes are the default quantization's download). A workspace adds or
 * replaces entries with models.json `local.recommended`, and hides some with `local.hide`.
 *
 * `tools` is whether the model can call tools. Claude Code is nothing but tool calls (read,
 * search, edit, run), so a model without them can't be picked for runs; one is listed so the
 * difference is visible. After a download, Ollama's own capabilities have the last word.
 */

export interface CatalogModel {
  /** The Ollama tag to pull: "qwen3.8:27b". */
  tag: string;
  label: string;
  /** "27B", "30B (3B active)". */
  params: string;
  diskGb: number;
  /** Context window the model supports, in tokens. */
  context: number;
  tools: boolean;
  /** What it's good for, in a few words. */
  goodFor: string;
  notes?: string;
}

export const RECOMMENDED: CatalogModel[] = [
  { tag: "qwen3.8:27b", label: "Qwen3.8 27B", params: "27B", diskGb: 18, context: 262144, tools: true, goodFor: "Coding and planning; the strongest all-rounder that fits one GPU" },
  { tag: "qwen3.6:35b-a3b-coding", label: "Qwen3.6 35B Coding", params: "35B (3B active)", diskGb: 24, context: 262144, tools: true, goodFor: "Agentic coding; fast for its size (mixture of experts)" },
  { tag: "nemotron-3.5-lightning:30b", label: "Nemotron 3.5 Lightning", params: "30B (3B active)", diskGb: 25, context: 1048576, tools: true, goodFor: "Long agent sessions; very long context" },
  { tag: "ornith:9b", label: "Ornith 9B", params: "9B", diskGb: 5.6, context: 262144, tools: true, goodFor: "Code search and exploring on an ordinary laptop" },
  { tag: "granite4.1:8b", label: "Granite 4.1 8B", params: "8B", diskGb: 5.3, context: 131072, tools: true, goodFor: "Small and quick; reliable tool calls and JSON" },
  { tag: "deepseek-r1:14b", label: "DeepSeek-R1 14B", params: "14B", diskGb: 9, context: 131072, tools: false, goodFor: "Reasoning and chat", notes: "No tool calling, so it can't read or search code in a run." },
];

export type Fit = "gpu" | "partial" | "cpu" | "too-big" | "no-disk";

export interface FitInput { diskGb: number; vramGb: number | null; unified: boolean; memoryGb: number; freeDiskGb: number | null; installed: boolean }

/**
 * Roughly whether a model runs well here. Memory needed ≈ its size plus ~20% (the context
 * cache at a 64k window, runtime overhead):
 *   gpu      fits in video memory (or Apple unified memory): full speed
 *   partial  part on the GPU, the rest in RAM: works, slower
 *   cpu      no usable GPU but enough RAM: works, slow
 *   too-big  not enough memory
 *   no-disk  not downloaded and not enough free disk to download it
 */
export function fitOf(f: FitInput): Fit {
  const need = f.diskGb * 1.2;
  if (!f.installed && f.freeDiskGb != null && f.freeDiskGb < f.diskGb + 2) return "no-disk";
  if (f.vramGb != null && f.vramGb >= need) return "gpu";
  if (f.unified) return f.memoryGb * 0.75 >= need ? "gpu" : "too-big";
  // Leave the OS and its apps ~6 GB of RAM.
  const ram = f.memoryGb - 6;
  if (f.vramGb != null && f.vramGb >= 4 && f.vramGb + ram >= need) return "partial";
  return ram >= need ? "cpu" : "too-big";
}

export const FIT_LABEL: Record<Fit, string> = {
  gpu: "Fits on the GPU",
  partial: "Partly on the GPU (slower)",
  cpu: "Runs on the CPU (slow)",
  "too-big": "Too big for this computer",
  "no-disk": "Not enough disk space",
};
