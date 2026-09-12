import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("accepted QuickJS deadline profile", () => {
  it("builds without an independent instruction-count quota", () => {
    const source = readFileSync(
      new URL("./js-exec-worker.js", import.meta.url),
      "utf8",
    );
    expect(source.includes("INTERRUPT_CYCLES")).toBe(false);
    expect(source.includes("interruptCount++")).toBe(false);
    expect(source.includes("runtime.setMemoryLimit(MEMORY_LIMIT)")).toBe(true);
  });

  it("allows finite work beyond the former five-second sub-deadline", async () => {
    const env = new Bash({
      javascript: true,
      executionLimits: { maxJsTimeoutMs: 10_000 },
    });
    const result = await env.exec(
      `js-exec -c 'const start = Date.now(); while (Date.now() - start < 5001) {} console.log("done");'`,
    );
    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({ stdout: "done\n", stderr: "", exitCode: 0 });
  }, 15_000);
});
