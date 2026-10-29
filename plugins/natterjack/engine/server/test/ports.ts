// Ports for tests that start real servers, so test files (and a developer's own apps) can't collide.
import net from "node:net";

const given = new Set<number>();

/**
 * A port nothing is listening on, picked at random in 20000-32000 and bind-checked (as freeBlock),
 * not the OS's pick: an ephemeral port, once released, can go to any outgoing connection before
 * the test's server binds it. Never the same port twice in one test file.
 */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if (!given.has(port) && await bindable(port)) { given.add(port); return port; }
  }
  throw new Error("No free port in 20000-32000.");
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/**
 * A base port whose base+offset ports are all free, for config that fixes ports up front (a
 * worktree's slot is base+100, ...). Picked in 20000-32000: below the ephemeral ranges Linux
 * (32768+) and Windows (49152+) hand out, so a connection elsewhere can't take one meanwhile.
 */
export async function freeBlock(offsets: number[]): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const base = 20000 + Math.floor(Math.random() * 110) * 100;
    let ok = true;
    for (const o of offsets) if (!(await bindable(base + o))) { ok = false; break; }
    if (ok) return base;
  }
  throw new Error(`No free ports at offsets ${offsets.join(", ")} in 20000-32000.`);
}
