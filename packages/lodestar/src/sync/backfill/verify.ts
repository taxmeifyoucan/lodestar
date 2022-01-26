import {allForks, CachedBeaconStateAllForks, ISignatureSet} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Root, allForks as allForkTypes, ssz, Slot} from "@chainsafe/lodestar-types";
import {GENESIS_SLOT} from "@chainsafe/lodestar-params";
import {TreeBacked} from "@chainsafe/ssz";

import {IBlsVerifier} from "../../chain/bls";
import {BackfillSyncError, BackfillSyncErrorCode} from "./errors";

export type BackfillBlockHeader = {
  slot: Slot;
  root: Root;
};

export type BackfillBlock = BackfillBlockHeader & {block: allForks.SignedBeaconBlock};

export function verifyBlockSequence(
  config: IBeaconConfig,
  blocks: TreeBacked<allForkTypes.SignedBeaconBlock>[],
  anchorRoot: Root
): {
  nextAnchor: BackfillBlock | null;
  verifiedBlocks: TreeBacked<allForkTypes.SignedBeaconBlock>[];
  error?: BackfillSyncErrorCode.NOT_LINEAR;
} {
  let nextRoot: Root = anchorRoot;
  let nextAnchor: BackfillBlock | null = null;

  const verifiedBlocks: TreeBacked<allForkTypes.SignedBeaconBlock>[] = [];
  for (const block of blocks.reverse()) {
    const blockRoot = (block.message as TreeBacked<allForkTypes.BeaconBlock>).hashTreeRoot();
    if (!ssz.Root.equals(blockRoot, nextRoot)) {
      if (ssz.Root.equals(nextRoot, anchorRoot)) {
        throw new BackfillSyncError({code: BackfillSyncErrorCode.NOT_ANCHORED});
      }
      return {nextAnchor, verifiedBlocks, error: BackfillSyncErrorCode.NOT_LINEAR};
    }
    verifiedBlocks.push(block);
    nextAnchor = {block, slot: block.message.slot, root: nextRoot};
    nextRoot = block.message.parentRoot;
  }
  return {nextAnchor, verifiedBlocks};
}

export async function verifyBlockProposerSignature(
  bls: IBlsVerifier,
  state: CachedBeaconStateAllForks,
  blocks: allForkTypes.SignedBeaconBlock[]
): Promise<void> {
  if (blocks.length === 1 && blocks[0].message.slot === GENESIS_SLOT) return;
  const signatures = blocks.reduce((sigs: ISignatureSet[], block) => {
    // genesis block doesn't have valid signature
    if (block.message.slot !== GENESIS_SLOT) sigs.push(allForks.getProposerSignatureSet(state, block));
    return sigs;
  }, []);

  if (!(await bls.verifySignatureSets(signatures))) {
    throw new BackfillSyncError({code: BackfillSyncErrorCode.INVALID_SIGNATURE});
  }
}
