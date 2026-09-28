import { describe, expect, it } from "vitest";
import {
  changeTotals,
  changedFilesTree,
  fileLabel,
  treeStatus,
} from "./pull-files-view.js";

const file = (
  path: string,
  status: string,
  additions = 1,
  deletions = 0,
  previousPath: string | null = null,
) => ({ path, status, additions, deletions, previousPath });

describe("changed files view", () => {
  it("maps every Gitea file status onto a tree status", () => {
    expect(
      [
        "added",
        "copied",
        "deleted",
        "removed",
        "renamed",
        "modified",
        "changed",
      ].map(treeStatus),
    ).toEqual([
      "added",
      "added",
      "deleted",
      "deleted",
      "renamed",
      "modified",
      "modified",
    ]);
  });

  it("shows the previous path only for a real rename", () => {
    expect(fileLabel(file("b.ts", "renamed", 0, 0, "a.ts"))).toBe(
      "a.ts → b.ts",
    );
    expect(fileLabel(file("b.ts", "modified", 0, 0, "b.ts"))).toBe("b.ts");
    expect(fileLabel(file("b.ts", "modified"))).toBe("b.ts");
  });

  it("builds tree input and per-file counts in file order", () => {
    const tree = changedFilesTree([
      file("src/z.ts", "removed", 0, 7),
      file("src/a.ts", "added", 3, 0),
    ]);
    expect(tree.paths).toEqual(["src/z.ts", "src/a.ts"]);
    expect(tree.gitStatus).toEqual([
      { path: "src/z.ts", status: "deleted" },
      { path: "src/a.ts", status: "added" },
    ]);
    expect(tree.counts.get("src/z.ts")).toBe("+0 −7");
    expect(tree.counts.get("src/a.ts")).toBe("+3 −0");
  });

  it("totals additions and deletions", () => {
    expect(
      changeTotals([file("a", "modified", 2, 1), file("b", "added", 5, 0)]),
    ).toEqual({ additions: 7, deletions: 1 });
    expect(changeTotals([])).toEqual({ additions: 0, deletions: 0 });
  });
});
