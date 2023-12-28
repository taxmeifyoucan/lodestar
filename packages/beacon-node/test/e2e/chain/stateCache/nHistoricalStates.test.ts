import {describe, it, afterEach, expect} from "vitest";
import {ChainConfig} from "@lodestar/config";
import {Slot, phase0} from "@lodestar/types";
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
import {CacheType} from "../../../../src/chain/stateCache/types.js";

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
    const testCases: {
      name: string;
      reorgedSlot: number;
      reorgDistance: number;
      maxBlockStates: number;
      maxCPStateEpochsInMemory: number;
      reloadCount: number;
      persistCount: number;
      numStatesInMemory: number;
      numStatesPersisted: number;
      numEpochsInMemory: number;
      numEpochsPersisted: number;
    }[] = [
      /**
       * Block slot 12 has parent slot 9, block slot 10 and 11 are reorged
       *                        --------------------|---
       *                       /       ^  ^         ^  ^
       *                      /       12  13        16 17
       * |----------------|----------
       *                  ^  ^  ^  ^
       *                  8  9 10  11
       * */
      {
        name: "0 historical state, reorg in same epoch reorgedSlot=11 reorgDistance=3",
        reorgedSlot: 11,
        reorgDistance: 3,
        maxBlockStates: 1,
        maxCPStateEpochsInMemory: 0,
        // reload at cp epoch 1 once to regen state 9 (12 - 3)
        reloadCount: 1,
        // cp epoch 0 and cp epoch 1 and cp epoch 2, no need to persist cp epoch 1 again
        persistCount: 3,
        // run through slot 17, no state in memory
        numStatesInMemory: 0,
        // epoch 0 1 2
        numStatesPersisted: 3,
        numEpochsInMemory: 0,
        // epoch 0 1 2
        numEpochsPersisted: 3,
      },
      /**
       * Block slot 12 has parent slot 7, block slot 8 9 10 and 11 are reorged
       *                  --------------------------|---
       *                / |            ^  ^         ^  ^
       *               /  |           12  13        16 17
       * |----------------|----------
       *               ^  ^  ^  ^  ^
       *               7  8  9 10  11
       *                  ^
       *              2 checkpoint states at epoch 1 are persisted
       */
      {
        name: "0 historical state, reorg 1 epoch reorgedSlot=11 reorgDistance=5",
        reorgedSlot: 11,
        reorgDistance: 5,
        maxBlockStates: 1,
        maxCPStateEpochsInMemory: 0,
        // reload at cp epoch 0 once to regen state 7 (12 - 5)
        reloadCount: 1,
        // 1 cp state for epoch 0 & 2, and 2 cp states for epoch 1 (different roots)
        persistCount: 4,
        numStatesInMemory: 0,
        // epoch 0 1 2, epoch 1 has 2 checkpoint states
        numStatesPersisted: 4,
        numEpochsInMemory: 0,
        // epoch 0 1 2
        numEpochsPersisted: 3,
      },
    ];

    for (const {
      name,
      reorgedSlot,
      reorgDistance,
      maxBlockStates,
      maxCPStateEpochsInMemory,
      reloadCount,
      persistCount,
      numStatesInMemory,
      numStatesPersisted,
      numEpochsInMemory,
      numEpochsPersisted,
    } of testCases) {
      it(name, async function () {
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
            // run the first bn with ReorgedForkChoice, no nHistoricalStates flag so it does not have to reload
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
            metrics: {enabled: true},
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

        // wait for 1 more slot to persist states
        await waitForEvent<{slot: Slot}>(
          reorgedBn.chain.emitter,
          routes.events.EventType.block,
          240000,
          ({slot}) => slot === 17
        );

        const reloadMetricValues = await followupBn.metrics?.cpStateCache.stateReloadDuration.get();
        expect(
          reloadMetricValues?.values.find(
            (value) => value.metricName === "lodestar_cp_state_cache_state_reload_seconds_count"
          )?.value
        ).toEqual(reloadCount);

        const persistMetricValues = await followupBn.metrics?.cpStateCache.statePersistDuration.get();
        expect(
          persistMetricValues?.values.find(
            (value) => value.metricName === "lodestar_cp_state_cache_state_persist_seconds_count"
          )?.value
        ).toEqual(persistCount);

        // assert number of persisted/in-memory states
        const stateSizeMetricValues = await followupBn.metrics?.cpStateCache.size.get();
        const numStateInMemoryItem = stateSizeMetricValues?.values.find(
          (value) => value.labels.type === CacheType.inMemory
        );
        const numStatePersistedItem = stateSizeMetricValues?.values.find(
          (value) => value.labels.type === CacheType.persisted
        );
        expect(numStateInMemoryItem?.value).toEqual(numStatesInMemory);
        expect(numStatePersistedItem?.value).toEqual(numStatesPersisted);

        // assert number of epochs persisted/in-memory
        const epochSizeMetricValues = await followupBn.metrics?.cpStateCache.epochSize.get();
        const numEpochsInMemoryItem = epochSizeMetricValues?.values.find(
          (value) => value.labels.type === CacheType.inMemory
        );
        const numEpochsPersistedItem = epochSizeMetricValues?.values.find(
          (value) => value.labels.type === CacheType.persisted
        );
        expect(numEpochsInMemoryItem?.value).toEqual(numEpochsInMemory);
        expect(numEpochsPersistedItem?.value).toEqual(numEpochsPersisted);
      });
    }
  },
  // on local environment, it takes around 33s for 2 checkpoints so make it 60s
  {timeout: 60_000}
);
