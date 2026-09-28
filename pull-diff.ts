import { z } from "zod";

export const inlinePatchLimitBytes = 256 * 1024;

export const fileDiffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), patch: z.string().min(1) }),
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("binary") }),
  z.object({
    kind: z.literal("too-large"),
    bytes: z.number().int().positive(),
    limit: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["missing", "stale", "diff-too-large", "diff-failed"]),
  }),
]);
export type FileDiff = z.infer<typeof fileDiffSchema>;

export type RawPullDiff =
  | { kind: "text"; text: string }
  | { kind: "too-large" }
  | { kind: "failed" };

export type PullFileMeta = {
  path: string;
  previousPath: string | null;
  patch: string | null;
};

export type PullRevision = { head: string; base: string };

type DiffSection = {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: boolean;
  text: string;
};

const escapes: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

function readQuoted(
  source: string,
  start: number,
): { value: string; end: number } | null {
  const bytes: number[] = [];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"')
      return { value: Buffer.from(bytes).toString("utf8"), end: index + 1 };
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      index += 1;
      continue;
    }
    const next = source[index + 1];
    if (next === undefined) return null;
    const octal = source.slice(index + 1, index + 4);
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
    } else if (next in escapes) {
      bytes.push(escapes[next]!);
      index += 2;
    } else return null;
  }
  return null;
}

function unquote(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  const parsed = readQuoted(raw, 0);
  return parsed && parsed.end === raw.length ? parsed.value : null;
}

function stripPrefix(path: string | null, prefix: "a/" | "b/") {
  if (path === null || !path.startsWith(prefix)) return null;
  return path.slice(prefix.length);
}

function markerPath(raw: string, prefix: "a/" | "b/"): string | null {
  if (raw === "/dev/null") return null;
  const name = raw.startsWith('"') ? raw : raw.replace(/\t$/, "");
  return stripPrefix(unquote(name), prefix);
}

function headerPaths(
  rest: string,
): { oldPath: string; newPath: string } | null {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    if (!first || rest[first.end] !== " ") return null;
    const second = unquote(rest.slice(first.end + 1));
    const oldPath = stripPrefix(first.value, "a/");
    const newPath = stripPrefix(second, "b/");
    return oldPath !== null && newPath !== null ? { oldPath, newPath } : null;
  }
  const quotedSecond = rest.indexOf(' "b/');
  if (quotedSecond !== -1) {
    const oldPath = stripPrefix(rest.slice(0, quotedSecond), "a/");
    const newPath = stripPrefix(unquote(rest.slice(quotedSecond + 1)), "b/");
    return oldPath !== null && newPath !== null ? { oldPath, newPath } : null;
  }
  if ((rest.length - 5) % 2 !== 0) return null;
  const size = (rest.length - 5) / 2;
  const oldPath = stripPrefix(rest.slice(0, size + 2), "a/");
  const newPath = stripPrefix(rest.slice(size + 3), "b/");
  return rest[size + 2] === " " && oldPath !== null && oldPath === newPath
    ? { oldPath, newPath }
    : null;
}

function parseSection(lines: string[]): DiffSection {
  const header = headerPaths(lines[0]!.slice("diff --git ".length));
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let created = false;
  let deleted = false;
  let binary = false;
  let hunks = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith("@@")) {
      hunks = true;
      break;
    }
    if (line.startsWith("--- ")) oldPath = markerPath(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) newPath = markerPath(line.slice(4), "b/");
    else if (/^(rename|copy) from /.test(line))
      renameFrom = unquote(line.replace(/^(rename|copy) from /, ""));
    else if (/^(rename|copy) to /.test(line))
      renameTo = unquote(line.replace(/^(rename|copy) to /, ""));
    else if (line.startsWith("new file mode ")) created = true;
    else if (line.startsWith("deleted file mode ")) deleted = true;
    else if (
      line === "GIT binary patch" ||
      (line.startsWith("Binary files ") && line.endsWith(" differ"))
    )
      binary = true;
  }
  return {
    oldPath:
      oldPath !== undefined
        ? oldPath
        : created
          ? null
          : (renameFrom ?? header?.oldPath ?? null),
    newPath:
      newPath !== undefined
        ? newPath
        : deleted
          ? null
          : (renameTo ?? header?.newPath ?? null),
    binary,
    hunks,
    text: `${lines.join("\n").trimEnd()}\n`,
  };
}

export function parsePullDiff(raw: string): DiffSection[] {
  const sections: string[][] = [];
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  return sections.map(parseSection);
}

function bounded(patch: string, limit: number): FileDiff {
  const bytes = Buffer.byteLength(patch, "utf8");
  return bytes > limit
    ? { kind: "too-large", bytes, limit }
    : { kind: "text", patch };
}

export function assignFileDiffs(
  files: PullFileMeta[],
  raw: RawPullDiff | null,
  limit = inlinePatchLimitBytes,
): FileDiff[] {
  const sections = new Map<string, DiffSection | "ambiguous">();
  if (raw?.kind === "text")
    for (const section of parsePullDiff(raw.text)) {
      const key = section.newPath ?? section.oldPath;
      if (key === null) continue;
      sections.set(key, sections.has(key) ? "ambiguous" : section);
    }
  return files.map((file): FileDiff => {
    if (file.patch?.trim()) return bounded(file.patch, limit);
    if (raw === null || raw.kind === "failed")
      return { kind: "unavailable", reason: "diff-failed" };
    if (raw.kind === "too-large")
      return { kind: "unavailable", reason: "diff-too-large" };
    const section = sections.get(file.path);
    if (
      section === undefined ||
      section === "ambiguous" ||
      (file.previousPath !== null && section.oldPath !== file.previousPath)
    )
      return { kind: "unavailable", reason: "missing" };
    if (section.binary) return { kind: "binary" };
    if (!section.hunks) return { kind: "empty" };
    return bounded(section.text, limit);
  });
}

export function sameRevision(left: PullRevision, right: PullRevision) {
  return left.head === right.head && left.base === right.base;
}

function sha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value)
    ? value
    : null;
}

export function parseRevision(
  pull: Record<string, unknown>,
): PullRevision | null {
  const field = (value: unknown, key: string) =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const head = sha(field(pull.head, "sha"));
  const base = sha(pull.merge_base) ?? sha(field(pull.base, "sha"));
  return head && base ? { head, base } : null;
}
