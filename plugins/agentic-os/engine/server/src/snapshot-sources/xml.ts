/**
 * Shared by the object-store sources (Azure Blob, S3).
 *
 * Just enough XML for their listings: the responses are flat,
 * well-formed and machine-written, so elements are found by name rather than parsed
 * into a tree. Not a general XML parser.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()]);
}

/** The bodies of every <tag>…</tag> (attributes allowed on the opening tag), in order. */
export function elements(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (let m; (m = re.exec(xml)); ) out.push(m[1]);
  return out;
}

/** A `prefix` setting as a folder: no leading slash, one trailing slash ("" for none). */
export function folderPrefix(p: unknown): string {
  const s = String(p ?? "").trim().replace(/^\/+|\/+$/g, "");
  return s ? `${s}/` : "";
}

/** The decoded text of the first <tag>, or null. */
export function text(xml: string, tag: string): string | null {
  const e = elements(xml, tag)[0];
  return e === undefined ? null : decodeXml(e.trim());
}
