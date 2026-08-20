export function shouldActivatePetFromKeyboard({
  key
}: {
  key: string;
}): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

export function shouldOpenPetSettingsFromKeyboard({
  key,
  shiftKey
}: {
  key: string;
  shiftKey: boolean;
}): boolean {
  return key === "F10" && shiftKey;
}

export function shouldClosePetSettingsFromKeyboard({
  key,
  settingsOpen,
  isInputContext
}: {
  key: string;
  settingsOpen: boolean;
  isInputContext: boolean;
}): boolean {
  return key === "Escape" && settingsOpen && !isInputContext;
}

export function shouldStopTurnFromPetKeyboard({
  key,
  settingsOpen,
  isInputContext
}: {
  key: string;
  settingsOpen: boolean;
  isInputContext: boolean;
}): boolean {
  return key === "Escape" && !settingsOpen && !isInputContext;
}

export function isKeyboardInputContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName;
  return tagName === "TEXTAREA"
    || tagName === "INPUT"
    || tagName === "SELECT"
    || target.isContentEditable === true
    || target.getAttribute("contenteditable") === "true";
}
