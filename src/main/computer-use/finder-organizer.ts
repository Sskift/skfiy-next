import path from "node:path";
import type { RiskLevel } from "../../shared/types.js";

export type FinderEntryKind = "file" | "directory";

export interface FinderEntry {
  name: string;
  kind: FinderEntryKind;
}

export type FinderOrganizationOperation =
  | { type: "create_folder"; path: string }
  | { type: "move_file"; from: string; to: string };

export interface FinderOrganizationPlan {
  risk: RiskLevel;
  requiresApproval: boolean;
  operations: FinderOrganizationOperation[];
}

export interface FinderOrganizationRequest {
  rootPath: string;
  entries: FinderEntry[];
}

const EXTENSION_FOLDERS = new Map<string, string>([
  [".gif", "Images"],
  [".jpeg", "Images"],
  [".jpg", "Images"],
  [".png", "Images"],
  [".webp", "Images"],
  [".doc", "Documents"],
  [".docx", "Documents"],
  [".md", "Documents"],
  [".pdf", "Documents"],
  [".txt", "Documents"],
  [".js", "Code"],
  [".jsx", "Code"],
  [".json", "Code"],
  [".ts", "Code"],
  [".tsx", "Code"],
  [".zip", "Archives"],
  [".tar", "Archives"],
  [".gz", "Archives"]
]);

export function createFinderOrganizationPlan(
  request: FinderOrganizationRequest
): FinderOrganizationPlan {
  const rootPath = path.resolve(request.rootPath);
  const operations: FinderOrganizationOperation[] = [];
  const createdFolders = new Set<string>();

  for (const entry of request.entries) {
    if (entry.kind !== "file") {
      continue;
    }

    assertSafeEntryName(entry.name);
    const folderName = readFolderName(entry.name);
    const folderPath = path.join(rootPath, folderName);

    if (!createdFolders.has(folderPath)) {
      operations.push({ type: "create_folder", path: folderPath });
      createdFolders.add(folderPath);
    }

    operations.push({
      type: "move_file",
      from: path.join(rootPath, entry.name),
      to: path.join(folderPath, entry.name)
    });
  }

  return {
    risk: "medium",
    requiresApproval: operations.length > 0,
    operations
  };
}

function readFolderName(fileName: string): string {
  return EXTENSION_FOLDERS.get(path.extname(fileName).toLowerCase()) ?? "Other";
}

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0
    || path.isAbsolute(name)
    || name.includes("/")
    || name.includes("\\")
    || name.split(path.sep).includes("..")
    || name === ".."
    || name.startsWith("../")
  ) {
    throw new Error("Finder organization entries must stay inside the root folder.");
  }
}
