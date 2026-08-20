import { describe, expect, it } from "vitest";
import {
  isKeyboardInputContext,
  shouldActivatePetFromKeyboard,
  shouldClosePetSettingsFromKeyboard,
  shouldOpenPetSettingsFromKeyboard,
  shouldStopTurnFromPetKeyboard
} from "./app-pet-keyboard";

describe("pet keyboard decisions", () => {
  it("activates on Enter and Space", () => {
    expect(shouldActivatePetFromKeyboard({ key: "Enter" })).toBe(true);
    expect(shouldActivatePetFromKeyboard({ key: " " })).toBe(true);
    expect(shouldActivatePetFromKeyboard({ key: "Spacebar" })).toBe(true);
  });

  it("does not activate on other keys", () => {
    expect(shouldActivatePetFromKeyboard({ key: "Tab" })).toBe(false);
    expect(shouldActivatePetFromKeyboard({ key: "Escape" })).toBe(false);
    expect(shouldActivatePetFromKeyboard({ key: "F10" })).toBe(false);
    expect(shouldActivatePetFromKeyboard({ key: "ArrowDown" })).toBe(false);
  });

  it("opens settings on Shift+F10", () => {
    expect(shouldOpenPetSettingsFromKeyboard({ key: "F10", shiftKey: true })).toBe(true);
  });

  it("does not open settings on plain F10 or other keys", () => {
    expect(shouldOpenPetSettingsFromKeyboard({ key: "F10", shiftKey: false })).toBe(false);
    expect(shouldOpenPetSettingsFromKeyboard({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldOpenPetSettingsFromKeyboard({ key: " ", shiftKey: true })).toBe(false);
  });

  it("closes settings on Escape when the settings panel is open", () => {
    expect(shouldClosePetSettingsFromKeyboard({
      key: "Escape",
      settingsOpen: true,
      isInputContext: false
    })).toBe(true);
  });

  it("does not close settings on Escape when the panel is closed", () => {
    expect(shouldClosePetSettingsFromKeyboard({
      key: "Escape",
      settingsOpen: false,
      isInputContext: false
    })).toBe(false);
  });

  it("stops the turn on Escape when settings is closed", () => {
    expect(shouldStopTurnFromPetKeyboard({
      key: "Escape",
      settingsOpen: false,
      isInputContext: false
    })).toBe(true);
  });

  it("does not stop the turn on Escape when settings is open", () => {
    expect(shouldStopTurnFromPetKeyboard({
      key: "Escape",
      settingsOpen: true,
      isInputContext: false
    })).toBe(false);
  });

  it("does not close settings or stop on Escape inside an input context", () => {
    expect(shouldClosePetSettingsFromKeyboard({
      key: "Escape",
      settingsOpen: true,
      isInputContext: true
    })).toBe(false);
    expect(shouldStopTurnFromPetKeyboard({
      key: "Escape",
      settingsOpen: false,
      isInputContext: true
    })).toBe(false);
  });

  it("detects input contexts from DOM targets", () => {
    const textarea = document.createElement("textarea");
    const input = document.createElement("input");
    const select = document.createElement("select");
    const button = document.createElement("button");
    const div = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");

    expect(isKeyboardInputContext(textarea)).toBe(true);
    expect(isKeyboardInputContext(input)).toBe(true);
    expect(isKeyboardInputContext(select)).toBe(true);
    expect(isKeyboardInputContext(editable)).toBe(true);
    expect(isKeyboardInputContext(button)).toBe(false);
    expect(isKeyboardInputContext(div)).toBe(false);
    expect(isKeyboardInputContext(null)).toBe(false);
  });
});
