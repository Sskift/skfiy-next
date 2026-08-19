import type { TurnReplay } from "./computer-use/turn-replay-store.js";
import { createRuntimeSnapshotCurrentTurnFromTaskEvent } from "./main-runtime-snapshot-payload.js";
import {
  writeRuntimeSnapshot,
  writeRuntimeTurnMarker,
  type RuntimeSnapshotCurrentTurnInput
} from "./runtime-snapshot.js";
import type { TaskEvent } from "./task-event-view.js";

export interface MainRuntimeSnapshotWriter {
  writeRuntimeSnapshot: typeof writeRuntimeSnapshot;
  writeRuntimeTurnMarker: typeof writeRuntimeTurnMarker;
}

export interface PersistMainRuntimeSnapshotInput {
  homeDir: string;
  replay: TurnReplay | null;
  currentTurnEvent?: TaskEvent;
  writer?: MainRuntimeSnapshotWriter;
}

const defaultRuntimeSnapshotWriter: MainRuntimeSnapshotWriter = {
  writeRuntimeSnapshot,
  writeRuntimeTurnMarker
};

export async function persistMainRuntimeSnapshot({
  homeDir,
  replay,
  currentTurnEvent,
  writer = defaultRuntimeSnapshotWriter
}: PersistMainRuntimeSnapshotInput): Promise<void> {
  const currentTurn: RuntimeSnapshotCurrentTurnInput | undefined = currentTurnEvent
    ? createRuntimeSnapshotCurrentTurnFromTaskEvent(currentTurnEvent)
    : undefined;

  await writer.writeRuntimeSnapshot({
    homeDir,
    replay,
    currentTurn
  });

  if (currentTurn) {
    await writer.writeRuntimeTurnMarker({
      homeDir,
      currentTurn
    });
  }
}
