export interface ChromeTurnHostGrantIdentity {
  turnId: string;
  toolCallId: string;
}

export interface ChromeTurnHostGrant extends ChromeTurnHostGrantIdentity {
  host: string;
}

export interface ChromeTurnHostGrantStore {
  grant(identity: ChromeTurnHostGrantIdentity, hostOrUrl: unknown): ChromeTurnHostGrant;
  has(identity: ChromeTurnHostGrantIdentity, hostOrUrl: unknown): boolean;
  clear(identity: ChromeTurnHostGrantIdentity): boolean;
}

export function createChromeTurnHostGrantStore(): ChromeTurnHostGrantStore {
  const grantsByTool = new Map<string, Set<string>>();

  return {
    grant(identity, hostOrUrl) {
      const toolKey = readToolKey(identity);
      if (!toolKey) {
        throw new Error("Chrome turn host grant requires a tool identity.");
      }

      const host = normalizeChromeHost(hostOrUrl);
      if (!host) {
        throw new Error("Chrome turn host grant requires a valid host.");
      }

      const hosts = grantsByTool.get(toolKey) ?? new Set<string>();
      hosts.add(host);
      grantsByTool.set(toolKey, hosts);

      return {
        turnId: identity.turnId.trim(),
        toolCallId: identity.toolCallId.trim(),
        host
      };
    },

    has(identity, hostOrUrl) {
      const toolKey = readToolKey(identity);
      const host = normalizeChromeHost(hostOrUrl);
      return Boolean(toolKey && host && grantsByTool.get(toolKey)?.has(host));
    },

    clear(identity) {
      const toolKey = readToolKey(identity);
      return toolKey ? grantsByTool.delete(toolKey) : false;
    }
  };
}

function readToolKey(identity: ChromeTurnHostGrantIdentity): string | undefined {
  const turnId = readOpaqueId(identity?.turnId);
  const toolCallId = readOpaqueId(identity?.toolCallId);
  return turnId && toolCallId
    ? `${turnId.length}:${turnId}${toolCallId.length}:${toolCallId}`
    : undefined;
}

function readOpaqueId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

// Mirrors normalizeChromeHost in chrome-host-policy.ts. Kept local so the grant
// store stays self-contained; the durable policy never persists current-turn
// hosts, so both normalizers must agree on what a host is.
function normalizeChromeHost(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const input = value.trim();
  if (!input) {
    return "";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try {
      return new URL(input).host.toLowerCase();
    } catch {
      return "";
    }
  }

  if (/[/?#\s]/.test(input)) {
    return "";
  }

  try {
    return new URL(`https://${input}`).host.toLowerCase();
  } catch {
    return "";
  }
}
