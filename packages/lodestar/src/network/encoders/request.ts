import {Method, Methods, ReqRespEncoding} from "../../constants";
import {ILogger} from "@chainsafe/lodestar-utils/lib/logger";
import {RequestBody} from "@chainsafe/lodestar-types";
import {decode, encode} from "varint";
import {IDecompressor} from "./interface";
import {SnappyFramesUncompress} from "./snappy-frames/uncompress";
import BufferList from "bl";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {getCompressor, getDecompressor} from "./utils";

export function eth2RequestEncode(
  config: IBeaconConfig, logger: ILogger, method: Method, encoding: ReqRespEncoding
): (source: AsyncIterable<RequestBody>) => AsyncGenerator<Buffer> {
  return (source => {
    return (async function*() {
      const type = Methods[method].requestSSZType(config);
      const compressor = getCompressor(encoding);
      for await (const request of source) {
        if(!type) continue;
        let serialized: Uint8Array;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          serialized = type.serialize(request as any);
        } catch (e) {
          logger.warn("Malformed input. Failed to serialize request for method " + method);
          continue;
        }
        yield Buffer.from(encode(serialized.length));
        yield* compressor(Buffer.from(serialized.buffer, serialized.byteOffset, serialized.length));
      }
    })();
  });
}

export function eth2RequestDecode(
  config: IBeaconConfig, logger: ILogger, method: Method, encoding: ReqRespEncoding
): (source: AsyncIterable<Buffer>) => AsyncGenerator<RequestBody> {
  return (source) => {
    return (async function*() {
      let sszDataLength: number = null;
      const decompressor = getDecompressor(encoding);
      const buffer = new BufferList();
      const type = Methods[method].requestSSZType(config);
      for await (let chunk of source) {
        if(sszDataLength === null) {
          sszDataLength = decode(chunk);
          chunk = chunk.slice(decode.bytes);
          if(chunk.length === 0) {
            continue;
          }
        }
        let uncompressed: Buffer;
        try {
          uncompressed = decompressor.uncompress(chunk);
        } catch (e) {
          logger.warn("Failed to decompress request data. Error: " + e.message);
          break;
        }
        if(uncompressed) {
          buffer.append(uncompressed);
        }
        if(buffer.length < sszDataLength) {
          continue;
        }
        if(buffer.length > sszDataLength) {
          logger.warn("Too long message received for method " + method);
          break;
        }
        try {
          yield type.deserialize(buffer.slice(0, sszDataLength)) as RequestBody;
        } catch (e) {
          logger.warn(`Malformed input. Failed to deserialize ${method} request type. Error: ${e.message}`);
        }
        //only one request body accepted
        break;
      }
    })();
  };
}