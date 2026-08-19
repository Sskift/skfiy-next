import { randomUUID } from "node:crypto";

import type { AssistantAgentTurnResult } from "./assistant-agent.js";
import { selectCommandRoute } from "./task-routing.js";

export interface SmokeAssistantTurnOptions {
  env?: NodeJS.ProcessEnv;
  createId?: () => string;
  now?: () => Date;
}

export function createSmokeAssistantAgentTaskTurn(
  input: string,
  {
    env = process.env,
    createId = () => `assistant-smoke-turn-${randomUUID()}`,
    now = () => new Date()
  }: SmokeAssistantTurnOptions = {}
): AssistantAgentTurnResult | undefined {
  if (env.SKFIY_SMOKE_ASSISTANT_COMPUTER_USE === "1") {
    const route = selectCommandRoute(input);
    if (
      route.kind !== "chrome"
      && route.kind !== "finder"
      && route.kind !== "ghostty"
      && route.kind !== "tmux_supervision"
    ) {
      return undefined;
    }

    const createdAt = now().toISOString();
    const id = createId();
    return {
      id,
      createdAt,
      status: "completed",
      providerLabel: "Codex",
      message: "我会通过 skfiy 的 smoke Background Agent fixture 请求受控的 Computer Use。",
      route,
      toolCalls: [
        {
          id: `${id}-tool-1`,
          type: "computer-use",
          name: "desktop-control",
          status: "planned",
          createdAt,
          input: {
            command: input.trim(),
            route
          }
        }
      ],
      cancellation: { requested: false }
    };
  }

  const smokePrompt = env.SKFIY_SMOKE_ASSISTANT_PROMPT?.trim();
  const smokeReply = env.SKFIY_SMOKE_ASSISTANT_REPLY?.trim();
  if (!smokePrompt || !smokeReply || input.trim() !== smokePrompt) {
    return undefined;
  }

  return {
    id: createId(),
    createdAt: now().toISOString(),
    status: "completed",
    providerLabel: "Codex",
    message: smokeReply,
    route: {
      kind: "chat",
      reason: "UI smoke uses a deterministic assistant reply to avoid live provider quota."
    },
    toolCalls: [],
    cancellation: { requested: false }
  };
}
