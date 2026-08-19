export const STOP_TURN_ACCELERATOR = "Control+Alt+Shift+Esc";
export const STOP_TURN_LABEL = "Ctrl Opt Shift Esc";
export const STOP_TURN_CHANNEL = "skfiy:stop-turn-hotkey";

export interface StopTurnHotkeyStatus {
  accelerator: string;
  label: string;
  registered: boolean;
}

interface HotkeyRegistry {
  register(accelerator: string, callback: () => void): boolean;
}

interface StopTurnWindow {
  isDestroyed: () => boolean;
  webContents: {
    send: (channel: string) => void;
  };
}

export function registerStopTurnHotkey({
  registry,
  getWindow
}: {
  registry: HotkeyRegistry;
  getWindow: () => StopTurnWindow | null;
}): boolean {
  return registry.register(STOP_TURN_ACCELERATOR, () => {
    const window = getWindow();

    if (!window || window.isDestroyed()) {
      return;
    }

    window.webContents.send(STOP_TURN_CHANNEL);
  });
}

export function readStopTurnHotkeyStatus(registered: boolean): StopTurnHotkeyStatus {
  return {
    accelerator: STOP_TURN_ACCELERATOR,
    label: STOP_TURN_LABEL,
    registered
  };
}
