import type { ChromeTaskClient } from "./orchestrator/chrome-task.js";
import type { CdpCommand } from "./computer-use/browser-control.js";

export interface ChromeCdpClientOptions {
  endpoint: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

interface ChromeCdpPage {
  type?: string;
  webSocketDebuggerUrl?: string;
}

export function createChromeCdpClient(options: ChromeCdpClientOptions): ChromeTaskClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;

  return {
    async sendCdpCommand(command: CdpCommand): Promise<unknown> {
      const webSocketDebuggerUrl = await findChromePageWebSocketUrl(options.endpoint, fetchImpl);
      return sendCdpCommand(webSocketDebuggerUrl, command, WebSocketImpl);
    },
    async waitForPageReady(): Promise<void> {
      const webSocketDebuggerUrl = await findChromePageWebSocketUrl(options.endpoint, fetchImpl);
      await sendCdpCommand(webSocketDebuggerUrl, createWaitForPageReadyCommand(), WebSocketImpl);
    }
  };
}

async function findChromePageWebSocketUrl(
  endpoint: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const response = await fetchImpl(new URL("/json/list", endpoint));
  if (!response.ok) {
    throw new Error(`Chrome CDP endpoint returned HTTP ${response.status}.`);
  }

  const pages = await response.json() as ChromeCdpPage[];
  const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("Chrome CDP endpoint has no controllable page target.");
  }

  return page.webSocketDebuggerUrl;
}

function sendCdpCommand(
  webSocketDebuggerUrl: string,
  command: CdpCommand,
  WebSocketImpl: typeof WebSocket
): Promise<unknown> {
  const ws = new WebSocketImpl(webSocketDebuggerUrl);

  return new Promise((resolve, reject) => {
    const id = 1;
    const cleanup = () => {
      ws.close();
    };

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method: command.method, params: command.params }));
    }, { once: true });

    ws.addEventListener("message", (raw) => {
      const message = JSON.parse(raw.data.toString());
      if (message.id !== id) {
        return;
      }

      cleanup();
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    });

    ws.addEventListener("error", () => {
      cleanup();
      reject(new Error("Chrome CDP WebSocket failed."));
    }, { once: true });
  });
}

function createWaitForPageReadyCommand(): CdpCommand {
  return {
    method: "Runtime.evaluate",
    params: {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        if (document.readyState === "complete" || document.readyState === "interactive") {
          resolve(true);
          return;
        }
        window.addEventListener("DOMContentLoaded", () => resolve(true), { once: true });
      })`
    }
  };
}
