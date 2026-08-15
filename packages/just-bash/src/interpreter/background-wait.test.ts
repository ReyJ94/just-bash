import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";

function controlledStatuses() {
  const resolvers = new Map<string, () => void>();
  const started = new Set<string>();
  const observedStatuses: string[] = [];
  const command = defineCommand("finish", async ([name, status]) => {
    started.add(name);
    await new Promise<void>((resolve) => resolvers.set(name, resolve));
    return {
      stdout: `${name}-out\n`,
      stderr: `${name}-err\n`,
      exitCode: Number(status),
    };
  });
  const mark = defineCommand("mark", async ([status]) => {
    observedStatuses.push(status);
    return { stdout: `first=${status}\n`, stderr: "", exitCode: 0 };
  });
  return { command, mark, observedStatuses, resolvers, started };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("job did not start");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("wait builtin", () => {
  it("returns zero when there are no jobs", async () => {
    const result = await new Bash().exec("wait; echo status=$?");
    expect(result.stdout).toBe("status=0\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("waits for a named PID and preserves its cached status", async () => {
    const result = await new Bash().exec(
      "false & pid=$!; wait $pid; echo first=$?; wait $pid; echo second=$?",
    );
    expect(result.stdout).toBe("first=1\nsecond=1\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("returns the last status when waiting for multiple PIDs", async () => {
    const result = await new Bash().exec(
      "false & one=$!; true & two=$!; wait $one $two; echo status=$?",
    );
    expect(result.stdout).toBe("status=0\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("wait -n returns the first completed selected job", async () => {
    const controls = controlledStatuses();
    const bash = new Bash({
      defenseInDepth: false,
      customCommands: [controls.command, controls.mark],
    });
    const execution = bash.exec(
      "finish slow 4 & slow=$!; finish fast 7 & fast=$!; " +
        "wait -n $slow $fast; mark $?; wait $slow; echo slow=$?",
    );
    await waitUntil(() => controls.started.size === 2);
    controls.resolvers.get("fast")?.();
    await waitUntil(() => controls.observedStatuses.length === 1);
    controls.resolvers.get("slow")?.();

    const result = await execution;
    expect(result.stdout).toBe("fast-out\nfirst=7\nslow-out\nslow=4\n");
    expect(result.stderr).toBe("fast-err\nslow-err\n");
    expect(result.exitCode).toBe(0);
  });

  it("accepts -f and returns the selected job status", async () => {
    const result = await new Bash().exec(
      "false & pid=$!; wait -f $pid; echo status=$?",
    );
    expect(result.stdout).toBe("status=1\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("rejects unknown PIDs and unsupported options exactly", async () => {
    const unknown = await new Bash().exec("wait 99999");
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toBe(
      "bash: wait: pid 99999 is not a child of this shell\n",
    );
    expect(unknown.exitCode).toBe(127);

    const option = await new Bash().exec("wait -z");
    expect(option.stdout).toBe("");
    expect(option.stderr).toBe(
      "bash: wait: -z: invalid option\nwait: usage: wait [-fn] [id ...]\n",
    );
    expect(option.exitCode).toBe(2);
  });

  it("treats launch as success under errexit but failing wait as failure", async () => {
    const launch = await new Bash().exec("set -e; false & echo launched; true");
    expect(launch.stdout).toBe("launched\n");
    expect(launch.stderr).toBe("");
    expect(launch.exitCode).toBe(0);

    const waited = await new Bash().exec(
      "set -e; false & pid=$!; wait $pid; echo unreachable",
    );
    expect(waited.stdout).toBe("");
    expect(waited.stderr).toBe("");
    expect(waited.exitCode).toBe(1);
  });
});
