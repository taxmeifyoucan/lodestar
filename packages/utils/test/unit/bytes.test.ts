import "../setup.js";
import {assert, expect} from "chai";
import {intToBytes, bytesToInt, compareBytesLe, intToBytesVanilla} from "../../src/index.js";

describe("intToBytes", () => {
  const zeroedArray = (length: number): number[] => Array.from({length}, () => 0);
  const testCases: {input: [bigint | number, number]; output: Buffer}[] = [
    {input: [255, 1], output: Buffer.from([255])},
    {input: [1, 4], output: Buffer.from([1, 0, 0, 0])},
    {input: [BigInt(255), 1], output: Buffer.from([255])},
    {input: [65535, 2], output: Buffer.from([255, 255])},
    {input: [BigInt(65535), 2], output: Buffer.from([255, 255])},
    {input: [16777215, 3], output: Buffer.from([255, 255, 255])},
    {input: [BigInt(16777215), 3], output: Buffer.from([255, 255, 255])},
    {input: [4294967295, 4], output: Buffer.from([255, 255, 255, 255])},
    {input: [BigInt(4294967295), 4], output: Buffer.from([255, 255, 255, 255])},
    {input: [65535, 8], output: Buffer.from([255, 255, ...zeroedArray(8 - 2)])},
    {input: [BigInt(65535), 8], output: Buffer.from([255, 255, ...zeroedArray(8 - 2)])},
    {input: [65535, 32], output: Buffer.from([255, 255, ...zeroedArray(32 - 2)])},
    {input: [BigInt(65535), 32], output: Buffer.from([255, 255, ...zeroedArray(32 - 2)])},
    {input: [65535, 48], output: Buffer.from([255, 255, ...zeroedArray(48 - 2)])},
    {input: [BigInt(65535), 48], output: Buffer.from([255, 255, ...zeroedArray(48 - 2)])},
    {input: [65535, 96], output: Buffer.from([255, 255, ...zeroedArray(96 - 2)])},
    {input: [BigInt(65535), 96], output: Buffer.from([255, 255, ...zeroedArray(96 - 2)])},
  ];
  for (const {input, output} of testCases) {
    const type = typeof input[0];
    const length = input[1];
    it(`should correctly serialize ${type} to bytes length ${length}`, () => {
      assert(intToBytes(input[0], input[1]).equals(output));
    });
  }

  const numTestCases = 10_000;
  it(`random check ${numTestCases} numbers`, () => {
    for (let i = 0; i < numTestCases; i++) {
      for (const [length, maxValue] of [
        [2, 0xffff],
        [4, 0xffffffff],
        [8, Number.MAX_SAFE_INTEGER],
      ]) {
        const value = Math.floor(Math.random() * maxValue);
        assert(
          intToBytes(value, length).equals(intToBytes(BigInt(value), length)),
          `failed at value ${value} and length ${length} le`
        );
        assert(
          intToBytes(value, length, "be").equals(intToBytes(BigInt(value), length, "be")),
          `failed at value ${value} and length ${length} be`
        );
        assert(
          intToBytesVanilla(value, length).equals(intToBytes(BigInt(value), length)),
          `failed at value ${value} and length ${length} le`
        );
        assert(
          intToBytesVanilla(value, length, "be").equals(intToBytes(BigInt(value), length, "be")),
          `failed at value ${value} and length ${length} be`
        );
      }
    }
  });
});

describe("bytesToInt", () => {
  const testCases: {input: Buffer; output: number}[] = [
    {input: Buffer.from([3]), output: 3},
    {input: Buffer.from([20, 0]), output: 20},
    {input: Buffer.from([3, 20]), output: 5123},
    {input: Buffer.from([255, 255]), output: 65535},
    {input: Buffer.from([255, 255, 255]), output: 16777215},
    {input: Buffer.from([255, 255, 255, 255]), output: 4294967295},
  ];
  for (const {input, output} of testCases) {
    it(`should produce ${output}`, () => {
      expect(bytesToInt(input)).to.be.equal(output);
    });
  }

  const numTetstCases = 10_000;
  it(`random check ${numTetstCases} numbers`, () => {
    for (let i = 0; i < numTetstCases; i++) {
      const value = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      const length = 8;
      const bytesLE = intToBytes(value, length);
      expect(bytesToInt(bytesLE)).to.be.equal(value, `le - failed at value ${value} and length ${length}`);
      const bytesBE = intToBytes(value, length, "be");
      expect(bytesToInt(bytesBE, "be")).to.be.equal(value, `be - failed at value ${value} and length ${length}`);
    }
  });
});

describe("compareBytesLe", () => {
  const testCases: {a: number; b: number; expected: number}[] = [
    {a: 0, b: 0, expected: 0},
    {a: 0, b: 1, expected: -1},
    {a: 0, b: 1_000_000_000, expected: -1},
    {a: 10_000, b: 1_000_000_000, expected: -1},
    {a: 1, b: 0, expected: 1},
    {a: 1_000_000_000, b: 0, expected: 1},
    {a: 1_000_000_000, b: 10_000, expected: 1},
  ];

  for (const {a, b, expected} of testCases) {
    it(`should return ${expected} for ${a} and ${b}`, () => {
      expect(compareBytesLe(intToBytes(a, 8), intToBytes(b, 8))).to.be.equal(expected);
    });
  }
});
