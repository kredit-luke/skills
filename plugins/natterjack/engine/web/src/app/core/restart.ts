/**
 * After POST /api/restart: poll until a different server answers (its boot
 * `startedAt` changed), so the page can reload onto it. The old server answers for a
 * moment before it stops, and the new one may first rebuild the UI (a minute or two
 * after an engine update), hence the long default timeout.
 */
export async function waitForRestart(
  previousStartedAt: string,
  fetchStartedAt: () => Promise<string | null>,
  { intervalMs = 1000, timeoutMs = 4 * 60_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(intervalMs);
    const now = await fetchStartedAt().catch(() => null);
    if (now && now !== previousStartedAt) return true;
  }
  return false;
}

/** The running server's start time, or null while it's down. */
export async function bootStartedAt(): Promise<string | null> {
  const res = await fetch('/api/boot', { cache: 'no-store' });
  if (!res.ok) return null;
  const boot = (await res.json()) as { startedAt?: string };
  return boot.startedAt || null;
}
