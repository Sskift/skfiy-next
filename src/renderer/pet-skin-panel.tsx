import { useState } from "react";
import { Download, RotateCcw, Eye } from "lucide-react";
import {
  getPetSpriteStyle,
  resolvePetAtlas,
  type PetAtlas
} from "./pet-atlas";
import type { PetSkinState } from "./app-pet-skin-state";

export function PetSkinPanel({
  importError,
  importPending = false,
  onImportSkin,
  onResetSkin,
  onSelectSkin,
  resetPending = false,
  skinState
}: {
  importError?: string;
  importPending?: boolean;
  onImportSkin: () => void;
  onResetSkin: () => void;
  onSelectSkin: (skinId: string) => void;
  resetPending?: boolean;
  skinState: PetSkinState;
}) {
  const [previewSkinId, setPreviewSkinId] = useState<string | null>(null);
  const previewAtlas = previewSkinId
    ? resolvePetAtlas({
        selectedSkinId: previewSkinId,
        customManifest: skinState.customManifest
      })
    : null;

  return (
    <div className="pet-skin-panel" aria-label="Pet skin settings">
      <div className="pet-skin-list">
        {skinState.skins.map((skin) => {
          const isSelected = skinState.selectedSkinId === skin.id;
          const isPreviewing = previewSkinId === skin.id;
          return (
            <div
              className="pet-skin-option"
              data-selected={isSelected ? "true" : undefined}
              key={skin.id}
            >
              <div className="pet-skin-option-info">
                <strong>{skin.displayName}</strong>
                {skin.redistribution === "local-only" ? (
                  <span className="pet-skin-badge" aria-label="Local-only skin">
                    local-only
                  </span>
                ) : null}
              </div>
              <div className="pet-skin-option-actions">
                <button
                  type="button"
                  aria-label={`${isPreviewing ? "Hide" : "Preview"} ${skin.displayName}`}
                  aria-pressed={isPreviewing}
                  onClick={() => setPreviewSkinId(isPreviewing ? null : skin.id)}
                >
                  <Eye size={13} aria-hidden="true" />
                  <span>{isPreviewing ? "Hide" : "Preview"}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Select ${skin.displayName}`}
                  disabled={isSelected}
                  onClick={() => {
                    onSelectSkin(skin.id);
                    setPreviewSkinId(null);
                  }}
                >
                  <span>{isSelected ? "Selected" : "Select"}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {previewAtlas ? (
        <PetSkinPreview atlas={previewAtlas} />
      ) : null}

      <div className="pet-skin-actions">
        <button
          type="button"
          aria-label="Import pet skin"
          disabled={importPending}
          onClick={onImportSkin}
        >
          <Download size={13} aria-hidden="true" />
          <span>{importPending ? "Importing…" : "Import skin"}</span>
        </button>
        <button
          type="button"
          aria-label="Reset pet skin to default"
          disabled={resetPending}
          onClick={onResetSkin}
        >
          <RotateCcw size={13} aria-hidden="true" />
          <span>{resetPending ? "Resetting…" : "Reset to default"}</span>
        </button>
      </div>

      {importError ? (
        <p className="pet-skin-error" role="alert">{importError}</p>
      ) : null}
    </div>
  );
}

function PetSkinPreview({ atlas }: { atlas: PetAtlas }) {
  return (
    <div className="pet-skin-preview" aria-label="Pet skin preview">
      <div
        className="skfiy-pet pet-skin-preview-sprite"
        style={getPetSpriteStyle("idle", atlas)}
      >
        <span className="pet-sprite-frame" aria-hidden="true" />
      </div>
    </div>
  );
}
