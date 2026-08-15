import { afterEach, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { _resetJsExecWorkerForTests } from "./js-exec.js";

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("tool calls did not overlap");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

afterEach(() => {
  _resetJsExecWorkerForTests();
});

describe("js-exec concurrent tool Promises", () => {
  it("starts two Promise.all calls before either host gate opens", async () => {
    const releases = [deferred(), deferred()];
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const bash = new Bash({
      defenseInDepth: false,
      executionLimits: { maxJsTimeoutMs: 1_000 },
      javascript: {
        invokeTool: async (_path, argsJson) => {
          const { id } = JSON.parse(argsJson) as { id: number };
          active++;
          maxActive = Math.max(maxActive, active);
          started.push(id);
          await releases[id - 1].promise;
          active--;
          return JSON.stringify({ id });
        },
      },
    });

    const execution = bash.exec(
      `js-exec -c '(async () => { const values = await Promise.all([tools.work.run({id:1}), tools.work.run({id:2})]); console.log(values.map(v => v.id).join(",")); })()'`,
    );
    try {
      await waitUntil(() => started.length === 2);
      expect(maxActive).toBe(2);
    } finally {
      releases[0].resolve();
      releases[1].resolve();
    }

    await expect(execution).resolves.toMatchObject({
      stdout: "1,2\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves Promise.all input order when host calls finish in reverse", async () => {
    const releases = [deferred(), deferred()];
    const started = new Set<number>();
    const completed: number[] = [];
    const bash = new Bash({
      defenseInDepth: false,
      javascript: {
        invokeTool: async (_path, argsJson) => {
          const { id } = JSON.parse(argsJson) as { id: number };
          started.add(id);
          await releases[id - 1].promise;
          completed.push(id);
          return JSON.stringify(id);
        },
      },
    });

    const execution = bash.exec(
      `js-exec -c '(async () => console.log(JSON.stringify(await Promise.all([tools.x({id:1}), tools.x({id:2})]))))()'`,
    );
    try {
      await waitUntil(() => started.size === 2);
      releases[1].resolve();
      await waitUntil(() => completed.length === 1);
      releases[0].resolve();
    } finally {
      releases[0].resolve();
      releases[1].resolve();
    }

    const result = await execution;
    expect(completed).toEqual([2, 1]);
    expect(result.stdout).toBe("[1,2]\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports three concurrent calls within the configured limit", async () => {
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const bash = new Bash({
      defenseInDepth: false,
      executionLimits: { maxConcurrentJobs: 3 },
      javascript: {
        invokeTool: async (_path, argsJson) => {
          active++;
          maxActive = Math.max(maxActive, active);
          await release.promise;
          active--;
          return argsJson;
        },
      },
    });

    const execution = bash.exec(
      `js-exec -c '(async () => console.log((await Promise.all([tools.x({n:1}), tools.x({n:2}), tools.x({n:3})])).length))()'`,
    );
    try {
      await waitUntil(() => maxActive === 3);
    } finally {
      release.resolve();
    }

    const result = await execution;
    expect(maxActive).toBe(3);
    expect(result.stdout).toBe("3\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("rejects calls above maxConcurrentJobs without invoking the host", async () => {
    const release = deferred();
    let calls = 0;
    const bash = new Bash({
      defenseInDepth: false,
      executionLimits: { maxConcurrentJobs: 1, maxJsTimeoutMs: 500 },
      javascript: {
        invokeTool: async () => {
          calls++;
          await release.promise;
          return "{}";
        },
      },
    });

    const execution = bash.exec(
      `js-exec -c '(async () => { try { await Promise.all([tools.x(), tools.x()]); } catch (e) { console.error(e.message); } })()'`,
    );
    await waitUntil(() => calls === 1);
    // Give the worker's second request a chance to reach the still-active
    // owner before releasing the first call.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release.resolve();
    const result = await execution;

    expect(calls).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("maximum concurrent tool calls exceeded (1)\n");
    expect(result.exitCode).toBe(0);
  });
});
