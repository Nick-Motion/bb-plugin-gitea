import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { giteaRpcContract } from "./server";

// Read-only check against an existing native schedule; never POST or DELETE a PR.
it.skipIf(!process.env.GITEA_LIVE_SCHEDULED_PR)("shows an existing live Gitea schedule without local toggle state", async () => {
  const repo = process.env.GITEA_LIVE_REPO!;
  const number = Number(process.env.GITEA_LIVE_SCHEDULED_PR);
  const host = createFakePluginHost({
    pluginId: "gitea",
    experimental_declaredIconNames: ["teacup"],
    settings: {
      baseUrl: process.env.GITEA_LIVE_BASE_URL!,
      teaProfile: process.env.GITEA_LIVE_PROFILE!,
      extraRepos: repo,
    },
    sdk: { projects: { list: async () => [] } },
  });
  try {
    await plugin(host.bb);
    const view = giteaRpcContract.getAutoFixerStatus.output.parse(
      await host.harness.behavior.callRpc("getAutoFixerStatus", {
        repo, number,
      }),
    );
    expect(view.automation.merge).toBe(true);
    expect(view.mergeError).toBeUndefined();
    const mine = giteaRpcContract.listMyPullRequests.output.parse(
      await host.harness.behavior.callRpc("listMyPullRequests", { repo, state: "open", query: "", refresh: true }),
    );
    expect(mine.items.find(item => item.number === number)?.autoFixer.automation.merge).toBe(true);
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
}, 30_000);
