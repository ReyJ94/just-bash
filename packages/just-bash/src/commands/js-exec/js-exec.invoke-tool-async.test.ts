import { afterEach, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { _resetJsExecWorkerForTests } from "./js-exec.js";

afterEach(() => {
  _resetJsExecWorkerForTests();
});

describe("js-exec async tool contract", () => {
  it("supports awaited calls and calls with no arguments", async () => {
    const seen: Array<{ path: string; argsJson: string }> = [];
    const bash = new Bash({
      javascript: {
        invokeTool: async (path, argsJson) => {
          seen.push({ path, argsJson });
          return JSON.stringify({ ok: true });
        },
      },
    });

    const result = await bash.exec(
      `js-exec -c '(async () => { const value = await tools.alpha.beta(); console.log(value.ok); })()'`,
    );

    expect(seen).toEqual([{ path: "alpha.beta", argsJson: "" }]);
    expect(result.stdout).toBe("true\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("makes host rejection catchable inside the guest", async () => {
    const bash = new Bash({
      javascript: {
        invokeTool: async () => {
          throw new Error("/private/path: tool exploded");
        },
      },
    });

    const result = await bash.exec(
      `js-exec -c '(async () => { try { await tools.fail(); } catch (e) { console.error(e.message); } })()'`,
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("<path>: tool exploded\n");
    expect(result.exitCode).toBe(0);
  });

  it("fails an uncaught awaited rejection with a sanitized diagnostic", async () => {
    const bash = new Bash({
      javascript: {
        invokeTool: async () => {
          throw new Error("/home/secret/tool failed");
        },
      },
    });

    const result = await bash.exec(
      `js-exec -c '(async () => { await tools.fail(); })()'`,
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^at .+: <path> failed\n$/);
    expect(result.exitCode).toBe(1);
  });

  it("reports malformed result JSON inside the guest", async () => {
    const bash = new Bash({
      javascript: { invokeTool: async () => "not-json" },
    });

    const result = await bash.exec(
      `js-exec -c '(async () => { try { await tools.bad(); } catch (e) { console.error(e.name); } })()'`,
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("SyntaxError\n");
    expect(result.exitCode).toBe(0);
  });

  it("supports top-level module await", async () => {
    const bash = new Bash({
      javascript: { invokeTool: async () => JSON.stringify({ value: 42 }) },
    });

    const result = await bash.exec(
      `js-exec -m -c 'const result = await tools.answer(); console.log(result.value)'`,
    );

    expect(result.stdout).toBe("42\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("drains a deliberately unawaited call before execution completes", async () => {
    let completed = false;
    const bash = new Bash({
      javascript: {
        invokeTool: async () => {
          await Promise.resolve();
          completed = true;
          return "{}";
        },
      },
    });

    const result = await bash.exec(
      `js-exec -c 'tools.fire.andForget(); console.log("returned")'`,
    );

    expect(completed).toBe(true);
    expect(result.stdout).toBe("returned\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("passes an abort signal to active host calls", async () => {
    const controller = new AbortController();
    let hostSignal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bash = new Bash({
      defenseInDepth: false,
      javascript: {
        invokeTool: async (_path, _argsJson, context) => {
          hostSignal = context?.signal;
          started();
          await new Promise<void>((resolve) =>
            hostSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          throw new Error("aborted");
        },
      },
    });

    const execution = bash.exec(
      `js-exec -c '(async () => { await tools.long(); })()'`,
      { signal: controller.signal },
    );
    await ready;
    controller.abort();
    const result = await execution;

    expect(hostSignal).toBeDefined();
    expect(hostSignal).not.toBe(controller.signal);
    expect(hostSignal?.aborted).toBe(true);
    expect(result.exitCode).toBe(124);
  });
});
