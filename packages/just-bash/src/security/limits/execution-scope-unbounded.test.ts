import { describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import { ExecutionScope } from "../../execution-scope.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import { resolveLimits } from "../../limits.js";

describe("unbounded per-operation work budgets", () => {
  it("accepts positive Infinity and retains per-kind and aggregate accounting", () => {
    const scope = new ExecutionScope(resolveLimits({ maxWorkUnits: 5 }));
    expect(scope.consumeLimited("glob", 0, Infinity)).toBe(0);
    expect(scope.consumeLimited("glob", 2, Infinity)).toBe(2);
    expect(scope.consumeLimited("glob", 3, Infinity)).toBe(5);
    expect(() => scope.consumeLimited("other", 1, Infinity)).toThrow(
      "other: aggregate work limit exceeded (5)",
    );
    expect(() => scope.chargeCommand()).toThrow(ExecutionLimitError);
  });

  it("allows both an unbounded operation and an unbounded aggregate", () => {
    const scope = new ExecutionScope(resolveLimits({ maxWorkUnits: Infinity }));
    expect(scope.consumeLimited("glob", 2, Infinity)).toBe(2);
    expect(scope.consumeLimited("glob", 3, Infinity)).toBe(5);
    expect(scope.consumeLimited("other", 7, Infinity)).toBe(7);
  });

  it.each([
    { counts: [0], maximum: 0 },
    { counts: [2, 3], maximum: 5 },
  ])("retains finite inclusive limits: $counts / $maximum", ({
    counts,
    maximum,
  }) => {
    const scope = new ExecutionScope(resolveLimits());
    for (const count of counts) scope.consumeLimited("glob", count, maximum);
    expect(() => scope.consumeLimited("glob", 1, maximum)).toThrow(
      `glob: glob work limit exceeded (${maximum})`,
    );
    expect(() => scope.consumeLimited("other", 0, Infinity)).toThrow(
      ExecutionLimitError,
    );
  });

  it.each([
    NaN,
    -Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid maxima and poisons sibling work: %s", (maximum) => {
    const scope = new ExecutionScope(resolveLimits());
    expect(() => scope.consumeLimited("glob", 0, maximum)).toThrow(
      ExecutionLimitError,
    );
    expect(() => scope.chargeCommand()).toThrow(ExecutionLimitError);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("does not let an unbounded maximum accept invalid work counts: %s", (count) => {
    const scope = new ExecutionScope(resolveLimits());
    expect(() => scope.consumeLimited("glob", count, Infinity)).toThrow(
      ExecutionLimitError,
    );
    expect(() => scope.chargeCommand()).toThrow(ExecutionLimitError);
  });

  it("still checks cancellation before charging unbounded work", () => {
    const controller = new AbortController();
    const scope = new ExecutionScope(resolveLimits(), controller.signal);
    controller.abort();
    expect(() => scope.consumeLimited("glob", 0, Infinity)).toThrow(
      ExecutionAbortedError,
    );
  });

  it("still checks the original deadline before charging unbounded work", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(1000);
      const scope = new ExecutionScope(
        resolveLimits({ maxExecutionTimeMs: 5 }),
      );
      clock.mockReturnValue(1006);
      expect(() => scope.consumeLimited("glob", 0, Infinity)).toThrow(
        ExecutionAbortedError,
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("does not disable byte-allocation guards", () => {
    const scope = new ExecutionScope(resolveLimits({ maxLiveBytes: 1 }));
    scope.consumeLimited("glob", 1, Infinity);
    scope.reserveBytes(1);
    expect(() => scope.reserveBytes(1)).toThrow(
      "live byte limit exceeded (1 bytes)",
    );
  });

  it("does not reopen a closed execution", async () => {
    const scope = new ExecutionScope(resolveLimits());
    await scope.close();
    expect(() => scope.consumeLimited("glob", 0, Infinity)).toThrow(
      "already closed",
    );
  });

  it("expands a wildcard with unbounded glob and aggregate budgets", async () => {
    const bash = new Bash({
      files: { "/tmp/a.md": "A", "/tmp/b.md": "B" },
      executionLimits: { maxGlobOperations: Infinity, maxWorkUnits: Infinity },
    });
    expect(await bash.exec("printf '%s\\n' /tmp/*.md")).toMatchObject({
      exitCode: 0,
      stdout: "/tmp/a.md\n/tmp/b.md\n",
      stderr: "",
    });
  });
});
