import { afterEach, describe, expect, it, vi } from "vitest";
import * as clock from "../../security/trusted-globals.js";
import {
  createSharedBuffer,
  OpCode,
  ProtocolBuffer,
  Status,
} from "./protocol.js";
import { SyncBackend } from "./sync-backend.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function exchange(
  reply: (
    protocol: ProtocolBuffer,
    timeout: number | undefined,
  ) => "ok" | "timed-out",
) {
  const buffer = createSharedBuffer();
  const protocol = new ProtocolBuffer(buffer);
  vi.spyOn(ProtocolBuffer.prototype, "waitForResult").mockImplementation(
    (timeout) => reply(protocol, timeout),
  );
  return { protocol, backend: new SyncBackend(buffer, 100) };
}

describe("whole-read worker aggregation and lifetime", () => {
  it("uses one operation budget across pieces and returns only complete raw bytes", () => {
    let now = 0;
    const budgets: number[] = [];
    const offsets: number[] = [];
    vi.spyOn(clock, "_performanceNow").mockImplementation(() => now);
    const { backend } = exchange((p, timeout) => {
      budgets.push(timeout ?? -1);
      const offset = p.getOpCode() === OpCode.READ_FILE ? 0 : p.getReadOffset();
      offsets.push(offset);
      p.setReadTotalLength(5);
      p.setResult(
        new Uint8Array(
          offset === 0 ? [0, 255] : offset === 2 ? [65, 66] : [67],
        ),
      );
      p.setStatus(Status.SUCCESS);
      now += 30;
      return "ok";
    });
    expect([...backend.readFile("/source")]).toEqual([0, 255, 65, 66, 67]);
    expect(offsets).toEqual([0, 2, 4]);
    expect(budgets).toEqual([100, 70, 40]);
  });

  it("aborts a retained snapshot when the complete allocation fails", () => {
    const operations: number[] = [];
    const total = 123;
    const { backend } = exchange((p) => {
      operations.push(p.getOpCode());
      p.setReadTotalLength(total);
      p.setResult(new Uint8Array([1]));
      p.setStatus(Status.SUCCESS);
      return "ok";
    });
    vi.stubGlobal(
      "Uint8Array",
      new Proxy(Uint8Array, {
        construct(target, args) {
          if (args[0] === total) throw new RangeError("allocation failed");
          return Reflect.construct(target, args);
        },
      }),
    );
    expect(() => backend.readFile("/source")).toThrow("allocation failed");
    expect(operations).toEqual([OpCode.READ_FILE, OpCode.READ_FILE_ABORT]);
  });

  it.each([
    "empty piece",
    "changed length",
    "oversized piece",
  ])("rejects %s without returning partial data", (kind) => {
    const operations: number[] = [];
    const { backend } = exchange((p) => {
      const op = p.getOpCode();
      operations.push(op);
      const first = op === OpCode.READ_FILE;
      p.setReadTotalLength(!first && kind === "changed length" ? 6 : 5);
      p.setResult(
        new Uint8Array(
          first
            ? [1, 2]
            : kind === "empty piece"
              ? []
              : kind === "oversized piece"
                ? [3, 4, 5, 6]
                : [3, 4, 5],
        ),
      );
      p.setStatus(Status.SUCCESS);
      return "ok";
    });
    expect(() => backend.readFile("/source")).toThrow();
    expect(operations.at(-1)).toBe(OpCode.READ_FILE_ABORT);
  });

  it.each([
    "continuation timeout",
    "abort timeout",
  ])("closes uncertain exchange on %s instead of reusing it", (kind) => {
    const operations: number[] = [];
    const { backend, protocol } = exchange((p) => {
      const op = p.getOpCode();
      operations.push(op);
      if (op !== OpCode.READ_FILE) return "timed-out";
      p.setReadTotalLength(5);
      p.setResult(new Uint8Array(kind === "abort timeout" ? [] : [1, 2]));
      p.setStatus(Status.SUCCESS);
      return "ok";
    });
    expect(() => backend.readFile("/source")).toThrow();
    expect(protocol.getStatus()).toBe(Status.CLOSED);
    const count = operations.length;
    expect(() => backend.readFile("/other")).toThrow();
    expect(operations.length).toBe(count);
  });
});
