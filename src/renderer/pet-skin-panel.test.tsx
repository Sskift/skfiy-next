import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PetSkinPanel } from "./pet-skin-panel";
import { createPetSkinState, type PetSkinState } from "./app-pet-skin-state";
import type { PetAtlasManifest } from "./pet-atlas";

function createLocalManifest(overrides: Partial<PetAtlasManifest> = {}): PetAtlasManifest {
  return {
    displayName: "Test local skin",
    slug: "test-local-skin",
    asset: "file:///tmp/test-skin/origin.png",
    frameWidth: 192,
    frameHeight: 208,
    columns: 1,
    rows: 1,
    source: "custom-user",
    states: {
      idle: { row: 0, frames: 1, frameMs: 170 },
      "running-right": { row: 0, frames: 1, frameMs: 90 },
      "running-left": { row: 0, frames: 1, frameMs: 90 },
      waving: { row: 0, frames: 1, frameMs: 120 },
      jumping: { row: 0, frames: 1, frameMs: 95 },
      failed: { row: 0, frames: 1, frameMs: 150 },
      waiting: { row: 0, frames: 1, frameMs: 190 },
      running: { row: 0, frames: 1, frameMs: 85 },
      review: { row: 0, frames: 1, frameMs: 135 }
    },
    ...overrides
  };
}

function createStateWithLocalSkin(): PetSkinState {
  return createPetSkinState({ customManifest: createLocalManifest() });
}

describe("PetSkinPanel", () => {
  it("renders bundled and imported skins", () => {
    const state = createStateWithLocalSkin();
    render(
      <PetSkinPanel
        skinState={state}
        onSelectSkin={vi.fn()}
        onImportSkin={vi.fn()}
        onResetSkin={vi.fn()}
      />
    );

    expect(screen.getByText("skfiy black cat")).toBeInTheDocument();
    expect(screen.getByText("Test local skin")).toBeInTheDocument();
  });

  it("shows a local-only badge for imported skins", () => {
    const state = createStateWithLocalSkin();
    render(
      <PetSkinPanel
        skinState={state}
        onSelectSkin={vi.fn()}
        onImportSkin={vi.fn()}
        onResetSkin={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/local-only skin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/local-only skin/i)).toHaveTextContent("local-only");
  });

  it("previews a skin without committing the selection", () => {
    const state = createStateWithLocalSkin();
    const onSelectSkin = vi.fn();
    render(
      <PetSkinPanel
        skinState={state}
        onSelectSkin={onSelectSkin}
        onImportSkin={vi.fn()}
        onResetSkin={vi.fn()}
      />
    );

    expect(screen.queryByLabelText(/pet skin preview/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /preview skfiy black cat/i }));
    expect(screen.getByLabelText(/pet skin preview/i)).toBeInTheDocument();
    expect(onSelectSkin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /hide skfiy black cat/i }));
    expect(screen.queryByLabelText(/pet skin preview/i)).not.toBeInTheDocument();
  });

  it("calls onSelectSkin when a skin is selected", () => {
    const state = createStateWithLocalSkin();
    const onSelectSkin = vi.fn();
    render(
      <PetSkinPanel
        skinState={state}
        onSelectSkin={onSelectSkin}
        onImportSkin={vi.fn()}
        onResetSkin={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /select skfiy black cat/i }));
    expect(onSelectSkin).toHaveBeenCalledWith("skfiy-black-cat");
  });

  it("disables the select button for the currently selected skin", () => {
    const state = createStateWithLocalSkin();
    render(
      <PetSkinPanel
        skinState={state}
        onSelectSkin={vi.fn()}
        onImportSkin={vi.fn()}
        onResetSkin={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /select test local skin/i })).toBeDisabled();
  });

  it("calls onImportSkin when the import button is clicked", () => {
    const state = createPetSkinState();
    const onImportSkin = vi.fn();
    render(
      <PetSkinPanel
        skinState={state}
        onSelectSkin={vi.fn()}
        onImportSkin={onImportSkin}
        onResetSkin={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /import pet skin/i }));
    expect(onImportSkin).toHaveBeenCalledTimes(1);
  });

  it("surfaces import validation errors", () => {
    const state = createPetSkinState();
    render(
      <PetSkinPanel
        importError="Unsupported pet skin source extension: .txt"
        skinState={state}
        onSelectSkin={vi.fn()}
        onImportSkin={vi.fn()}
        onResetSkin={vi.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unsupported pet skin source extension: .txt"
    );
  });

  it("calls onResetSkin when the reset button is clicked", () => {
    const state = createStateWithLocalSkin();
    const onResetSkin = vi.fn();
    render(
      <PetSkinPanel
        skinState={state}
        onSelectSkin={vi.fn()}
        onImportSkin={vi.fn()}
        onResetSkin={onResetSkin}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /reset pet skin to default/i }));
    expect(onResetSkin).toHaveBeenCalledTimes(1);
  });
});
