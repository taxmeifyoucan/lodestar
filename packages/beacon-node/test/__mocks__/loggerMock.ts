import {vi, MockedObject} from "vitest";
import {Logger} from "@lodestar/logger";

export type MockedLogger = MockedObject<Logger>;

export function getMockedLogger(): MockedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  };
}
