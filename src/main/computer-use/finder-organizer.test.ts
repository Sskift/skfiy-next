import { describe, expect, it } from "vitest";
import { createFinderOrganizationPlan, isSafeFinderEntryName } from "./finder-organizer";

describe("createFinderOrganizationPlan", () => {
  it("plans safe folder creation and moves for a test folder", () => {
    expect(createFinderOrganizationPlan({
      rootPath: "/tmp/skfiy-demo",
      entries: [
        { name: "photo.png", kind: "file" },
        { name: "notes.pdf", kind: "file" },
        { name: "script.ts", kind: "file" },
        { name: "already-folder", kind: "directory" }
      ]
    })).toEqual({
      risk: "medium",
      requiresApproval: true,
      operations: [
        { type: "create_folder", path: "/tmp/skfiy-demo/Images" },
        {
          type: "move_file",
          from: "/tmp/skfiy-demo/photo.png",
          to: "/tmp/skfiy-demo/Images/photo.png"
        },
        { type: "create_folder", path: "/tmp/skfiy-demo/Documents" },
        {
          type: "move_file",
          from: "/tmp/skfiy-demo/notes.pdf",
          to: "/tmp/skfiy-demo/Documents/notes.pdf"
        },
        { type: "create_folder", path: "/tmp/skfiy-demo/Code" },
        {
          type: "move_file",
          from: "/tmp/skfiy-demo/script.ts",
          to: "/tmp/skfiy-demo/Code/script.ts"
        }
      ]
    });
  });

  it("never emits destructive delete operations", () => {
    const plan = createFinderOrganizationPlan({
      rootPath: "/tmp/skfiy-demo",
      entries: [{ name: "archive.zip", kind: "file" }]
    });

    expect(plan.operations.map((operation) => operation.type)).not.toContain("delete");
  });

  it("rejects entries that escape the test folder", () => {
    expect(() => createFinderOrganizationPlan({
      rootPath: "/tmp/skfiy-demo",
      entries: [{ name: "../secret.txt", kind: "file" }]
    })).toThrow("Finder organization entries must stay inside the root folder.");
  });

  it("accepts one bounded file name and rejects path, control, and dot names", () => {
    expect(isSafeFinderEntryName("holiday photo.png")).toBe(true);
    for (const name of ["", ".", "..", "../photo.png", "folder/photo.png", "bad\nname"]) {
      expect(isSafeFinderEntryName(name)).toBe(false);
    }
  });
});
