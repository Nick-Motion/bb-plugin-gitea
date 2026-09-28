import type { GitStatus, GitStatusEntry } from "@pierre/trees";

export type ChangedFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
};

export type ChangedFilesTree = {
  paths: string[];
  gitStatus: GitStatusEntry[];
  counts: ReadonlyMap<string, string>;
};

export function treeStatus(status: string): GitStatus {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "deleted":
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

export function fileCounts(file: Pick<ChangedFile, "additions" | "deletions">) {
  return `+${file.additions} −${file.deletions}`;
}

export function fileLabel(file: Pick<ChangedFile, "path" | "previousPath">) {
  return file.previousPath && file.previousPath !== file.path
    ? `${file.previousPath} → ${file.path}`
    : file.path;
}

export function changedFilesTree(
  files: readonly ChangedFile[],
): ChangedFilesTree {
  return {
    paths: files.map((file) => file.path),
    gitStatus: files.map((file) => ({
      path: file.path,
      status: treeStatus(file.status),
    })),
    counts: new Map(files.map((file) => [file.path, fileCounts(file)])),
  };
}

export function changeTotals(files: readonly ChangedFile[]) {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}
