import { describe, expect, it } from "vitest";
import {
  assignFileDiffs,
  parsePullDiff,
  parseRevision,
  sameRevision,
  type PullFileMeta,
} from "./pull-diff";

const hunk = "@@ -1 +1 @@\n-old\n+new";

function file(
  path: string,
  previousPath: string | null = null,
  patch: string | null = null,
): PullFileMeta {
  return { path, previousPath, patch };
}

const multiFile = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  hunk,
  "diff --git a/old name.ts b/new name.ts",
  "similarity index 90%",
  "rename from old name.ts",
  "rename to new name.ts",
  "--- a/old name.ts",
  "+++ b/new name.ts",
  hunk,
  "diff --git a/added.ts b/added.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/added.ts",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/removed.ts b/removed.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/removed.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/logo.png b/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/moved.ts b/renamed.ts",
  "similarity index 100%",
  "rename from moved.ts",
  "rename to renamed.ts",
  "diff --git a/script.sh b/script.sh",
  "old mode 100644",
  "new mode 100755",
  "",
].join("\n");

describe("parsePullDiff", () => {
  it("reads old and new paths from markers, renames, creations, and deletions", () => {
    expect(
      parsePullDiff(multiFile).map(({ oldPath, newPath, binary, hunks }) => ({
        oldPath,
        newPath,
        binary,
        hunks,
      })),
    ).toEqual([
      {
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        binary: false,
        hunks: true,
      },
      {
        oldPath: "old name.ts",
        newPath: "new name.ts",
        binary: false,
        hunks: true,
      },
      { oldPath: null, newPath: "added.ts", binary: false, hunks: true },
      { oldPath: "removed.ts", newPath: null, binary: false, hunks: true },
      { oldPath: "logo.png", newPath: "logo.png", binary: true, hunks: false },
      {
        oldPath: "moved.ts",
        newPath: "renamed.ts",
        binary: false,
        hunks: false,
      },
      {
        oldPath: "script.sh",
        newPath: "script.sh",
        binary: false,
        hunks: false,
      },
    ]);
  });

  it("decodes C-quoted UTF-8, escaped, and tab-terminated paths", () => {
    const raw = [
      'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"',
      '--- "a/docs/caf\\303\\251.md"',
      '+++ "b/docs/caf\\303\\251.md"',
      hunk,
      'diff --git a/plain.txt "b/quote\\"d\\ttab.txt"',
      "rename from plain.txt",
      'rename to "quote\\"d\\ttab.txt"',
      "diff --git a/spaced file.txt b/spaced file.txt",
      "--- a/spaced file.txt\t",
      "+++ b/spaced file.txt\t",
      hunk,
      "",
    ].join("\r\n");
    expect(
      parsePullDiff(raw).map(({ oldPath, newPath }) => [oldPath, newPath]),
    ).toEqual([
      ["docs/café.md", "docs/café.md"],
      ["plain.txt", 'quote"d\ttab.txt'],
      ["spaced file.txt", "spaced file.txt"],
    ]);
  });

  it("ignores text before the first section", () => {
    expect(parsePullDiff("warning: noise\n")).toEqual([]);
  });
});

describe("assignFileDiffs", () => {
  const raw = { kind: "text" as const, text: multiFile };

  it("associates each API file with its own raw section", () => {
    const diffs = assignFileDiffs(
      [
        file("src/app.ts"),
        file("new name.ts", "old name.ts"),
        file("added.ts"),
        file("removed.ts"),
        file("logo.png"),
        file("renamed.ts", "moved.ts"),
        file("script.sh"),
        file("missing.ts"),
      ],
      raw,
    );
    expect(diffs.map((diff) => diff.kind)).toEqual([
      "text",
      "text",
      "text",
      "text",
      "binary",
      "empty",
      "empty",
      "unavailable",
    ]);
    expect(diffs[1]).toEqual({
      kind: "text",
      patch: expect.stringContaining("rename to new name.ts"),
    });
    expect(diffs[2]).toEqual({
      kind: "text",
      patch: expect.stringContaining("+hello"),
    });
    expect(diffs[1]).not.toEqual({
      kind: "text",
      patch: expect.stringContaining("src/app.ts"),
    });
    expect(diffs[7]).toEqual({ kind: "unavailable", reason: "missing" });
  });

  it("prefers the API patch and never reads the raw diff for it", () => {
    expect(
      assignFileDiffs([file("src/app.ts", null, hunk)], {
        kind: "failed",
      }),
    ).toEqual([{ kind: "text", patch: hunk }]);
  });

  it("refuses a section whose previous path disagrees with the API", () => {
    expect(assignFileDiffs([file("new name.ts", "other.ts")], raw)).toEqual([
      { kind: "unavailable", reason: "missing" },
    ]);
  });

  it("refuses paths that appear in more than one section", () => {
    const duplicated = `${multiFile}diff --git a/src/app.ts b/src/app.ts\n${hunk}\n`;
    expect(
      assignFileDiffs([file("src/app.ts")], { kind: "text", text: duplicated }),
    ).toEqual([{ kind: "unavailable", reason: "missing" }]);
  });

  it("applies the inline limit per file in UTF-8 bytes", () => {
    const diffs = assignFileDiffs(
      [
        file("src/app.ts"),
        file("big.ts", null, `@@ -1 +1 @@\n+${"é".repeat(40)}`),
      ],
      raw,
      64,
    );
    expect(diffs[0]).toEqual({
      kind: "too-large",
      bytes: expect.any(Number),
      limit: 64,
    });
    expect(diffs[1]).toEqual({ kind: "too-large", bytes: 93, limit: 64 });
  });

  it("reports why the whole raw diff is unavailable", () => {
    expect(assignFileDiffs([file("a.ts")], { kind: "too-large" })).toEqual([
      { kind: "unavailable", reason: "diff-too-large" },
    ]);
    expect(assignFileDiffs([file("a.ts")], { kind: "failed" })).toEqual([
      { kind: "unavailable", reason: "diff-failed" },
    ]);
    expect(assignFileDiffs([file("a.ts")], null)).toEqual([
      { kind: "unavailable", reason: "diff-failed" },
    ]);
  });
});

describe("revisions", () => {
  it("binds to the head sha and the merge base when Gitea reports one", () => {
    expect(
      parseRevision({
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
        merge_base: "c".repeat(40),
      }),
    ).toEqual({ head: "a".repeat(40), base: "c".repeat(40) });
    expect(
      parseRevision({
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
      }),
    ).toEqual({ head: "a".repeat(40), base: "b".repeat(40) });
  });

  it("rejects missing or non-hex revisions", () => {
    expect(
      parseRevision({ head: { sha: "abc" }, base: { sha: "b".repeat(40) } }),
    ).toBeNull();
    expect(parseRevision({ head: { sha: "a".repeat(40) } })).toBeNull();
  });

  it("compares head and base", () => {
    const left = { head: "a".repeat(40), base: "b".repeat(40) };
    expect(sameRevision(left, { ...left })).toBe(true);
    expect(sameRevision(left, { ...left, base: "c".repeat(40) })).toBe(false);
  });
});
