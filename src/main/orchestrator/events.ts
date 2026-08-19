import type { RiskDecision } from "../../shared/types.js";
import type { DesktopAppState } from "../computer-use/types.js";

export type GhosttyTaskEvent =
  | {
      type: "started";
      command: string;
      risk: RiskDecision;
    }
  | {
      type: "approval_required";
      command: string;
      risk: RiskDecision;
    }
  | {
      type: "locating_app";
      appName: string;
    }
  | {
      type: "session_opened";
      appName: string;
      title: string;
      pid: number;
    }
  | {
      type: "app_activated";
      appName: string;
      bundleId: string;
      pid?: number;
    }
  | {
      type: "session_initialized";
      title: string;
      marker: string;
    }
  | {
      type: "action_verified";
      actionType: string;
      status: "passed" | "failed" | "needs_user_confirmation";
      message?: string;
      reason?: string;
    }
  | {
      type: "verification_failed";
      stage: "permissions" | "desktop_session" | "activate" | "initialize" | "before" | "after";
      reason: string;
    }
  | {
      type: "recovery_attempted";
      stage: "before" | "after";
      action: "activate" | "open";
      reason: string;
    }
  | {
      type: "screenshot_before";
      path: string;
      observation: DesktopAppState;
    }
  | {
      type: "typing";
      command: string;
    }
  | {
      type: "submitted";
      key: "enter";
    }
  | {
      type: "screenshot_after";
      path: string;
      observation: DesktopAppState;
    }
  | {
      type: "completed";
      command: string;
      summary: string;
    };
