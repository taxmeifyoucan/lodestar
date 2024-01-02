import {phase0} from "@lodestar/types";

// With db implementation, persistedKey is serialized data of a checkpoint
export type PersistedKey = Uint8Array;

// Make this generic to support testing
export interface CPStatePersistentApis {
  write: (cpKey: phase0.Checkpoint, stateBytes: Uint8Array) => Promise<PersistedKey>;
  remove: (persistentKey: PersistedKey) => Promise<void>;
  read: (persistentKey: PersistedKey) => Promise<Uint8Array | null>;
  readKeys: () => Promise<PersistedKey[]>;
  persistedKeyToCheckpoint: (persistentKey: PersistedKey) => phase0.Checkpoint;
}
