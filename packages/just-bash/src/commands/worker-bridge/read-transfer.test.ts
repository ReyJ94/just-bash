import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { BridgeHandler } from "./bridge-handler.js";
import {
  createSharedBuffer,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  Status,
} from "./protocol.js";

const scratch = 8 * 1024 * 1024;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function start(fs = new InMemoryFs(), timeout = 5000) {
  const buffer = createSharedBuffer();
  const protocol = new ProtocolBuffer(buffer);
  const handler = new BridgeHandler(buffer, fs, "/", "read-test");
  const run = handler.run(timeout);
  cleanups.push(async () => {
    handler.stop();
    await run;
  });
  return { buffer, protocol, handler, run };
}

async function request(
  protocol: ProtocolBuffer,
  op: OpCodeType,
  offset = 0,
  total = 0,
) {
  protocol.reset();
  protocol.setOpCode(op);
  protocol.setPath("/source");
  if (op === OpCode.READ_FILE_NEXT) {
    protocol.setReadOffset(offset);
    protocol.setReadTotalLength(total);
  }
  protocol.setStatus(Status.READY);
  protocol.notify();
  await vi.waitFor(() => expect(protocol.getStatus()).not.toBe(Status.READY));
  return protocol.getStatus();
}

describe("one coherent, privately chunked file read", () => {
  it("returns one immutable snapshot and releases it at the final piece", async () => {
    const bytes = new Uint8Array(scratch + 3).fill(65);
    bytes.set([0, 255, 66], scratch);
    const fs = new InMemoryFs();
    const read = vi.spyOn(fs, "readFileBuffer").mockResolvedValue(bytes);
    const { protocol } = start(fs);
    expect(await request(protocol, OpCode.READ_FILE)).toBe(Status.SUCCESS);
    expect(protocol.getReadTotalLength()).toBe(bytes.length);
    expect(protocol.getResultLength()).toBe(scratch);
    expect(protocol.getResult().every((byte) => byte === 65)).toBe(true);
    bytes.fill(90);
    expect(
      await request(protocol, OpCode.READ_FILE_NEXT, scratch, bytes.length),
    ).toBe(Status.SUCCESS);
    expect([...protocol.getResult()]).toEqual([0, 255, 66]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      await request(
        protocol,
        OpCode.READ_FILE_NEXT,
        bytes.length,
        bytes.length,
      ),
    ).toBe(Status.ERROR);
    expect(await request(protocol, OpCode.READ_FILE)).toBe(Status.SUCCESS);
    expect(protocol.getResult().every((byte) => byte === 90)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    "offset",
    "total",
  ])("rejects an inconsistent %s and abandons that snapshot", async (field) => {
    const fs = new InMemoryFs({ "/source": new Uint8Array(scratch + 1) });
    const { protocol } = start(fs);
    expect(await request(protocol, OpCode.READ_FILE)).toBe(Status.SUCCESS);
    expect(
      await request(
        protocol,
        OpCode.READ_FILE_NEXT,
        field === "offset" ? scratch - 1 : scratch,
        field === "total" ? scratch : scratch + 1,
      ),
    ).toBe(Status.ERROR);
    expect(
      await request(protocol, OpCode.READ_FILE_NEXT, scratch, scratch + 1),
    ).toBe(Status.ERROR);
  });

  it.each([
    OpCode.READ_FILE_ABORT,
    OpCode.EXISTS,
    OpCode.EXIT,
  ])("retires an abandoned read on operation %s", async (op) => {
    const { protocol, run } = start(
      new InMemoryFs({ "/source": new Uint8Array(scratch + 1) }),
    );
    expect(await request(protocol, OpCode.READ_FILE)).toBe(Status.SUCCESS);
    expect(await request(protocol, op)).toBe(Status.SUCCESS);
    if (op === OpCode.EXIT) {
      expect((await run).exitCode).toBe(0);
    } else {
      expect(
        await request(protocol, OpCode.READ_FILE_NEXT, scratch, scratch + 1),
      ).toBe(Status.ERROR);
    }
  });

  it("does not share a snapshot between bridge instances", async () => {
    const a = start(
      new InMemoryFs({ "/source": new Uint8Array(scratch + 1).fill(65) }),
    );
    const b = start(
      new InMemoryFs({ "/source": new Uint8Array(scratch + 1).fill(66) }),
    );
    for (const bridge of [a, b])
      expect(await request(bridge.protocol, OpCode.READ_FILE)).toBe(
        Status.SUCCESS,
      );
    for (const [bridge, byte] of [
      [a, 65],
      [b, 66],
    ] as const) {
      expect(
        await request(
          bridge.protocol,
          OpCode.READ_FILE_NEXT,
          scratch,
          scratch + 1,
        ),
      ).toBe(Status.SUCCESS);
      expect([...bridge.protocol.getResult()]).toEqual([byte]);
    }
  });

  it.each([
    "stop",
    "worker close",
    "deadline",
  ])("settles a pending read on %s and ignores late FS completion", async (kind) => {
    let finish!: (bytes: Uint8Array) => void;
    const fs = new InMemoryFs();
    const read = vi.spyOn(fs, "readFileBuffer").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { protocol, handler, run } = start(
      fs,
      kind === "deadline" ? 100 : 5000,
    );
    const response = request(protocol, OpCode.READ_FILE);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    try {
      if (kind === "stop") handler.stop();
      if (kind === "worker close") protocol.close();
      let ended = false;
      void run.then(() => {
        ended = true;
      });
      await vi.waitFor(() => expect(ended).toBe(true), { timeout: 500 });
      await response;
      const status = protocol.getStatus();
      const result = protocol.getResult();
      finish(new Uint8Array(scratch + 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(protocol.getStatus()).toBe(status);
      expect(protocol.getResult()).toEqual(result);
      if (kind === "deadline") expect((await run).exitCode).toBe(124);
      else expect(status).toBe(Status.CLOSED);
    } finally {
      finish(new Uint8Array());
      handler.stop();
      await response;
    }
  });

  it("closes between pieces and prevents reuse", async () => {
    const { protocol, handler, run } = start(
      new InMemoryFs({ "/source": new Uint8Array(scratch + 1) }),
    );
    expect(await request(protocol, OpCode.READ_FILE)).toBe(Status.SUCCESS);
    handler.stop();
    await run;
    expect(protocol.getStatus()).toBe(Status.CLOSED);
  });

  it("carries safe-integer lengths without 32-bit wrap and rejects invalid lengths", () => {
    const protocol = new ProtocolBuffer(createSharedBuffer());
    for (const length of [0, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER]) {
      protocol.setReadTotalLength(length);
      protocol.setReadOffset(length);
      expect(protocol.getReadTotalLength()).toBe(length);
      expect(protocol.getReadOffset()).toBe(length);
    }
    for (const length of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => protocol.setReadTotalLength(length)).toThrow();
      expect(() => protocol.setReadOffset(length)).toThrow();
    }
  });
});
