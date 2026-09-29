import { describe, expect, it } from "vitest";
import { draftTitle, isDraftTitle } from "./draft-title.js";

describe("draft titles", () => {
  it("recognizes the prefixes Gitea treats as work in progress", () => {
    expect(isDraftTitle("WIP: Add pickers")).toBe(true);
    expect(isDraftTitle("[wip] Add pickers")).toBe(true);
    expect(isDraftTitle("Add WIP: pickers")).toBe(false);
  });

  it("adds one prefix and strips it again", () => {
    expect(draftTitle("Add pickers", true)).toBe("WIP: Add pickers");
    expect(draftTitle("[WIP] Add pickers", true)).toBe("WIP: Add pickers");
    expect(draftTitle("WIP:  Add pickers", false)).toBe("Add pickers");
  });
});
