export type RemoteBranchGroup = "pull" | "mine" | "other";

/**
 * Pull request state shown on a branch badge. `none` is an open pull request
 * without CI statuses. `checking` is an open pull request whose CI state is
 * not read yet.
 */
export type PullStatus =
  | "draft"
  | "failing"
  | "running"
  | "passing"
  | "none"
  | "merged"
  | "checking";

export interface RemoteBranchInput {
  name: string;
  /** Gitea user names of the last commit's author and committer. */
  authors: readonly string[];
  /** ISO time of the last commit. */
  updatedAt: string;
}

export interface PullInput {
  number: number;
  title: string;
  url: string;
  author: string;
  headBranch: string;
  state: "open" | "merged";
  status: PullStatus;
  /** Head commit, used to read the CI state of a `checking` pull request. */
  sha: string;
  /** ISO time of the last pull request update. */
  updatedAt: string;
}

export interface OrderedRemoteBranch {
  name: string;
  /** `pull` and `mine` are the signed-in user's branches; `other` is everyone else's. */
  group: RemoteBranchGroup;
  pull: { number: number; title: string; url: string; status: PullStatus } | null;
  updatedAt: string;
}

const groupRank: Record<RemoteBranchGroup, number> = {
  pull: 0,
  mine: 1,
  other: 2,
};

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newestByBranch(pulls: readonly PullInput[]): Map<string, PullInput> {
  const newest = new Map<string, PullInput>();
  for (const pull of pulls) {
    const current = newest.get(pull.headBranch);
    if (!current || time(pull.updatedAt) > time(current.updatedAt))
      newest.set(pull.headBranch, pull);
  }
  return newest;
}

/**
 * Sorts remote branches into three groups, newest first within each group:
 * branches with an open pull request by `login`, branches whose last commit
 * is by `login`, then all other branches. Pull request branches sort by the
 * pull request's update time. The others sort by their last commit time.
 *
 * Each branch carries the pull request its badge shows: the newest open
 * pull request from anyone, or else the newest merged one.
 */
export function orderRemoteBranches(args: {
  branches: readonly RemoteBranchInput[];
  pulls: readonly PullInput[];
  login: string | null;
}): OrderedRemoteBranch[] {
  const login = args.login?.toLowerCase() ?? null;
  const open = args.pulls.filter((pull) => pull.state === "open");
  const myOpen = newestByBranch(
    open.filter((pull) => login !== null && pull.author.toLowerCase() === login),
  );
  const anyOpen = newestByBranch(open);
  const merged = newestByBranch(args.pulls.filter((pull) => pull.state === "merged"));
  return args.branches
    .map((branch): OrderedRemoteBranch => {
      const badge = anyOpen.get(branch.name) ?? merged.get(branch.name);
      const pull = badge
        ? { number: badge.number, title: badge.title, url: badge.url, status: badge.status }
        : null;
      const mine = myOpen.get(branch.name);
      if (mine)
        return { name: branch.name, group: "pull", pull, updatedAt: mine.updatedAt };
      const authored =
        login !== null &&
        branch.authors.some((author) => author.toLowerCase() === login);
      return {
        name: branch.name,
        group: authored ? "mine" : "other",
        pull,
        updatedAt: branch.updatedAt,
      };
    })
    .sort(
      (left, right) =>
        groupRank[left.group] - groupRank[right.group] ||
        time(right.updatedAt) - time(left.updatedAt) ||
        left.name.localeCompare(right.name),
    );
}
