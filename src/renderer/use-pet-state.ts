import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isPetAtlasManifest } from "./pet-atlas";
import {
  INITIAL_PANEL_STATE,
  reducePanelState,
  type PanelStateAction
} from "./app-panel-state";
import {
  createPetSkinState,
  importPetSkinIntoState,
  resetPetSkin,
  selectPetSkin,
  type PetSkinState
} from "./app-pet-skin-state";
import type { DesktopApi } from "./app-types";

export function usePetState(
  api: DesktopApi,
  deps: { assistantInputRef: RefObject<HTMLTextAreaElement | null> }
) {
  const [petSkinState, setPetSkinState] = useState<PetSkinState>(() => createPetSkinState());
  const [petSkinImportError, setPetSkinImportError] = useState("");
  const [petSkinImportPending, setPetSkinImportPending] = useState(false);
  const [petSkinResetPending, setPetSkinResetPending] = useState(false);
  const [panelState, setPanelState] = useState(INITIAL_PANEL_STATE);
  const petKeyboardActivationRef = useRef<"assistant" | "settings" | null>(null);
  const panelWasOpenRef = useRef(false);
  const { assistantInputRef } = deps;

  const transitionPanelState = useCallback((action: PanelStateAction) => {
    setPanelState((state) => reducePanelState(state, action));
  }, []);

  // skfiy-next's panel state has no dedicated "open-details" action; toggling
  // while closed reaches the same details-open state.
  const openDetailsPanel = useCallback(() => {
    setPanelState((state) => (state.detailsOpen
      ? state
      : reducePanelState(state, { type: "toggle-details" })));
  }, []);

  useEffect(() => {
    let cancelled = false;

    void api.getPetSkin().then((skin) => {
      if (!cancelled && isPetAtlasManifest(skin)) {
        setPetSkinState((current) => importPetSkinIntoState(current, skin));
      }
    }).catch(() => {
      // A missing local skin should quietly keep the bundled fallback.
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const handleImportPetSkin = useCallback(() => {
    setPetSkinImportError("");
    setPetSkinImportPending(true);
    void api.importPetSkin().then((manifest) => {
      if (manifest) {
        setPetSkinState((current) => importPetSkinIntoState(current, manifest));
      }
    }).catch((error: unknown) => {
      setPetSkinImportError(error instanceof Error ? error.message : "Failed to import pet skin.");
    }).finally(() => {
      setPetSkinImportPending(false);
    });
  }, [api]);

  const handleResetPetSkin = useCallback(() => {
    setPetSkinResetPending(true);
    void api.resetPetSkin().then(() => {
      setPetSkinState((current) => resetPetSkin(current));
    }).catch(() => {
      // A failed reset should keep the current skin selection.
    }).finally(() => {
      setPetSkinResetPending(false);
    });
  }, [api]);

  const handleSelectPetSkin = useCallback((skinId: string) => {
    setPetSkinState((current) => selectPetSkin(current, skinId));
  }, []);

  useEffect(() => {
    if (panelState.assistantPanelOpen && petKeyboardActivationRef.current === "assistant") {
      petKeyboardActivationRef.current = null;
      window.setTimeout(() => {
        assistantInputRef.current?.focus();
      }, 0);
    }
  }, [panelState.assistantPanelOpen, assistantInputRef]);

  useEffect(() => {
    if (panelState.detailsOpen && petKeyboardActivationRef.current === "settings") {
      petKeyboardActivationRef.current = null;
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('button[aria-label="Close settings"]')?.focus();
      }, 0);
    }
  }, [panelState.detailsOpen]);

  useEffect(() => {
    const isOpen = panelState.assistantPanelOpen || panelState.detailsOpen;
    if (panelWasOpenRef.current && !isOpen) {
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('[data-pet-entry="true"]')?.focus();
      }, 0);
    }
    panelWasOpenRef.current = isOpen;
  }, [panelState.assistantPanelOpen, panelState.detailsOpen]);

  return {
    petSkinState,
    petSkinImportError,
    petSkinImportPending,
    petSkinResetPending,
    panelState,
    transitionPanelState,
    openDetailsPanel,
    handleImportPetSkin,
    handleResetPetSkin,
    handleSelectPetSkin,
    petKeyboardActivationRef
  };
}
