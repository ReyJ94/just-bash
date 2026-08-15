import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";

function never(): Promise<never> {
  return new Promise(() => {});
}

describe("background job lifecycle limits", () => {
  it("enforces maxConcurrentJobs without leaving work detached", async () => {
    const bash = new Bash({
      defenseInDepth: false,
      executionLimits: {
        maxConcurrentJobs: 1,
        maxExecutionTimeMs: 50,
        maxExtensionCleanupTimeMs: 5,
      },
      customCommands: [defineCommand("never", async () => never())],
    });

    const result = await bash.exec("never & never & wait");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "bash: maximum concurrent background jobs exceeded (1)\n",
    );
    expect(result.exitCode).toBe(126);
  });

  it("shares the command-count budget across jobs", async () => {
    const result = await new Bash({
      executionLimits: { maxCommandCount: 2 },
    }).exec("echo one & echo two & echo three & wait");

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toBe(
      "bash: too many commands executed (>2), increase executionLimits.maxCommandCount\n",
    );
  });

  it("shares output accounting across jobs without double charging", async () => {
    const result = await new Bash({
      executionLimits: { maxOutputSize: 4 },
    }).exec("printf aa & printf bb & wait");

    expect(result.stdout).toBe("aabb");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("turns an abort-ignorant background command into a bounded result", async () => {
    const bash = new Bash({
      defenseInDepth: false,
      executionLimits: {
        maxExecutionTimeMs: 20,
        maxExtensionCleanupTimeMs: 5,
      },
      customCommands: [defineCommand("never", async () => never())],
    });
    const started = Date.now();

    const result = await bash.exec("never &");

    expect(Date.now() - started).toBeLessThan(250);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("execution deadline");
    expect(result.exitCode).toBe(124);
  });
});
