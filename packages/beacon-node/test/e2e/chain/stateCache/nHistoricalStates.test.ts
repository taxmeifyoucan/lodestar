import {describe, it, afterEach, expect} from "vitest";
import {ChainConfig} from "@lodestar/config";
import {phase0} from "@lodestar/types";
import {TimestampFormatCode} from "@lodestar/logger";
import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {routes} from "@lodestar/api";
import {LogLevel, TestLoggerOpts, testLogger} from "../../../utils/logger.js";
import {getDevBeaconNode} from "../../../utils/node/beacon.js";
import {getAndInitDevValidators} from "../../../utils/node/validator.js";
import {waitForEvent} from "../../../utils/events/resolver.js";
import {ChainEvent, ReorgEventData} from "../../../../src/chain/emitter.js";
import {ReorgedForkChoice} from "../../../utils/mocks/forkchoice.js";
import {connect} from "../../../utils/network.js";

/**
 * Test different reorg scenarios to make sure the StateCache implementations are correct.
 */
describe(
  "chain/stateCache/n-historical states",
  function () {
    const validatorCount = 8;
    const testParams: Pick<ChainConfig, "SECONDS_PER_SLOT"> = {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      SECONDS_PER_SLOT: 2,
    };

    const afterEachCallbacks: (() => Promise<unknown> | void)[] = [];
    afterEach(async () => {
      while (afterEachCallbacks.length > 0) {
        const callback = afterEachCallbacks.pop();
        if (callback) await callback();
      }
    });

    const reorgedSlot = 11;
    const reorgDistance = 3;
    const maxBlockStates = 1;
    const maxCPStateEpochsInMemory = 0;
    // TODO: for loop
    /**
     *                                   (n+1)
     *                     -----------------|
     *                    /
     *         |---------|---------|
     *                   ^         ^
     *                 (n+1-x)   reorgedSlot n
     *                   ^
     *               commonAncestor
     *                   |<--reorgDistance-->|
     */
    it(`0 historical state, reorg in same epoch reorgedSlot=${reorgedSlot} reorgDistance=${reorgDistance}`, async function () {
      // the node needs time to transpile/initialize bls worker threads
      const genesisSlotsDelay = 7;
      const genesisTime = Math.floor(Date.now() / 1000) + genesisSlotsDelay * testParams.SECONDS_PER_SLOT;
      const testLoggerOpts: TestLoggerOpts = {
        level: LogLevel.debug,
        timestampFormat: {
          format: TimestampFormatCode.EpochSlot,
          genesisTime,
          slotsPerEpoch: SLOTS_PER_EPOCH,
          secondsPerSlot: testParams.SECONDS_PER_SLOT,
        },
      };

      const loggerNodeA = testLogger("Reorg-Node-A", testLoggerOpts);
      const loggerNodeB = testLogger("FollowUp-Node-B", {...testLoggerOpts, level: LogLevel.debug});

      const reorgedBn = await getDevBeaconNode({
        params: testParams,
        options: {
          sync: {isSingleNode: true},
          network: {allowPublishToZeroPeers: true},
          // run the first bn with ReorgedForkChoice
          chain: {
            blsVerifyAllMainThread: true,
            forkchoiceConstructor: ReorgedForkChoice,
            proposerBoostEnabled: true,
          },
        },
        validatorCount,
        logger: loggerNodeA,
      });

      // stop bn after validators
      afterEachCallbacks.push(() => reorgedBn.close());

      const {validators} = await getAndInitDevValidators({
        node: reorgedBn,
        logPrefix: "bn-a",
        validatorsPerClient: validatorCount,
        validatorClientCount: 1,
        startIndex: 0,
        useRestApi: false,
        testLoggerOpts,
      });

      afterEachCallbacks.push(() => Promise.all(validators.map((v) => v.close())));

      const followupBn = await getDevBeaconNode({
        params: testParams,
        options: {
          api: {rest: {enabled: false}},
          // run the 2nd bn with nHistoricalStates flag and the configured maxBlockStates, maxCPStateEpochsInMemory
          chain: {
            blsVerifyAllMainThread: true,
            forkchoiceConstructor: ReorgedForkChoice,
            nHistoricalStates: true,
            maxBlockStates,
            maxCPStateEpochsInMemory,
            proposerBoostEnabled: true,
          },
        },
        validatorCount,
        genesisTime: reorgedBn.chain.getHeadState().genesisTime,
        logger: loggerNodeB,
      });

      afterEachCallbacks.push(() => followupBn.close());

      await connect(followupBn.network, reorgedBn.network);

      // 1st checkpoint at slot 8, both nodes should reach same checkpoint
      const checkpoints = await Promise.all(
        [reorgedBn, followupBn].map((bn) =>
          waitForEvent<phase0.Checkpoint>(bn.chain.emitter, ChainEvent.checkpoint, 240000)
        )
      );
      expect(checkpoints[0]).toEqual(checkpoints[1]);
      expect(checkpoints[0].epoch).toEqual(1);
      const head = reorgedBn.chain.forkChoice.getHead();
      loggerNodeA.info("Node A emitted checkpoint event, head slot: " + head.slot);
      for (const bn of [reorgedBn, followupBn]) {
        (bn.chain.forkChoice as ReorgedForkChoice).reorgedSlot = reorgedSlot;
        (bn.chain.forkChoice as ReorgedForkChoice).reorgDistance = reorgDistance;
      }

      // both nodes see the reorg event
      const reorgDatas = await Promise.all(
        [reorgedBn, followupBn].map((bn) =>
          waitForEvent<ReorgEventData>(
            bn.chain.emitter,
            routes.events.EventType.chainReorg,
            240000,
            (reorgData) => reorgData.slot === reorgedSlot + 1
          )
        )
      );
      for (const reorgData of reorgDatas) {
        expect(reorgData.slot).toEqual(reorgedSlot + 1);
        expect(reorgData.depth).toEqual(reorgDistance);
      }

      // make sure both nodes can reach another checkpoint
      const checkpoints2 = await Promise.all(
        [reorgedBn, followupBn].map((bn) =>
          waitForEvent<phase0.Checkpoint>(bn.chain.emitter, ChainEvent.checkpoint, 240000)
        )
      );
      expect(checkpoints2[0]).toEqual(checkpoints2[1]);
      expect(checkpoints2[0].epoch).toEqual(2);
      // TODO: confirm the reload
    });
  },
  // on local environment, it takes around 33s for 2 checkpoints so make it 60s
  {timeout: 60_000}
);
