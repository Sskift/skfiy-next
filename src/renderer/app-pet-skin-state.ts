import {
  BUNDLED_PET_SKINS,
  DEFAULT_PET_SKIN_ID,
  isPetAtlasManifest,
  resolvePetAtlas,
  type PetAtlas,
  type PetAtlasManifest
} from "./pet-atlas";

export type PetSkinOrigin = "bundled" | "local";

export interface PetSkinOption {
  id: string;
  displayName: string;
  origin: PetSkinOrigin;
  redistribution?: "local-only";
}

export interface PetSkinState {
  skins: PetSkinOption[];
  selectedSkinId: string;
  previewSkinId: string | null;
  customManifest: PetAtlasManifest | null;
}

export function createPetSkinState(input?: {
  customManifest?: PetAtlasManifest | null;
}): PetSkinState {
  const customManifest = input?.customManifest && isPetAtlasManifest(input.customManifest)
    ? input.customManifest
    : null;

  return {
    skins: readPetSkinOptions(customManifest),
    selectedSkinId: customManifest?.slug ?? DEFAULT_PET_SKIN_ID,
    previewSkinId: null,
    customManifest
  };
}

export function previewPetSkin(state: PetSkinState, skinId: string): PetSkinState {
  if (!state.skins.some((skin) => skin.id === skinId)) {
    return state;
  }
  if (state.previewSkinId === skinId) {
    return state;
  }
  return { ...state, previewSkinId: skinId };
}

export function clearPetSkinPreview(state: PetSkinState): PetSkinState {
  if (state.previewSkinId === null) {
    return state;
  }
  return { ...state, previewSkinId: null };
}

export function selectPetSkin(state: PetSkinState, skinId: string): PetSkinState {
  if (!state.skins.some((skin) => skin.id === skinId)) {
    return state;
  }
  return { ...state, selectedSkinId: skinId, previewSkinId: null };
}

export function resetPetSkin(state: PetSkinState): PetSkinState {
  return {
    skins: readPetSkinOptions(null),
    selectedSkinId: DEFAULT_PET_SKIN_ID,
    previewSkinId: null,
    customManifest: null
  };
}

export function importPetSkinIntoState(
  state: PetSkinState,
  manifest: unknown
): PetSkinState {
  if (!isPetAtlasManifest(manifest)) {
    return state;
  }

  return {
    skins: readPetSkinOptions(manifest),
    selectedSkinId: manifest.slug,
    previewSkinId: null,
    customManifest: manifest
  };
}

export function resolvePetSkinAtlas(state: PetSkinState): PetAtlas {
  const activeSkinId = state.previewSkinId ?? state.selectedSkinId;
  return resolvePetAtlas({
    selectedSkinId: activeSkinId,
    customManifest: state.customManifest
  });
}

function readPetSkinOptions(customManifest: PetAtlasManifest | null): PetSkinOption[] {
  const bundledSkins: PetSkinOption[] = Object.values(BUNDLED_PET_SKINS).map((atlas) => ({
    id: atlas.slug,
    displayName: atlas.displayName,
    origin: "bundled"
  }));

  if (customManifest) {
    return [
      ...bundledSkins,
      {
        id: customManifest.slug,
        displayName: customManifest.displayName,
        origin: "local",
        redistribution: "local-only"
      }
    ];
  }

  return bundledSkins;
}
