import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("virtual background jobs", () => {
  it("starts independent jobs concurrently and drains them before exec returns", async () => {
    const releases = new Map<string, Deferred>([
      ["one", deferred()],
      ["two", deferred()],
    ]);
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const bash = new Bash({
      defenseInDepth: false,
      customCommands: [
        defineCommand("gate", async ([name]) => {
          active++;
          maxActive = Math.max(maxActive, active);
          started.push(name);
          await releases.get(name)?.promise;
          active--;
          return { stdout: `${name}\n`, stderr: "", exitCode: 0 };
        }),
      ],
    });

    const execution = bash.exec("gate one & gate two &");
    try {
      await waitUntil(
        () => started.length === 2,
        "both background jobs did not start",
      );
      expect(maxActive).toBe(2);
      let settled = false;
      void execution.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      releases.get("one")?.resolve();
      releases.get("two")?.resolve();
    }

    await expect(execution).resolves.toMatchObject({
      stdout: "one\ntwo\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("runs foreground work after launch and emits completed jobs once", async () => {
    const release = deferred();
    const backgroundReady = deferred();
    let backgroundStarted = false;
    const bash = new Bash({
      defenseInDepth: false,
      customCommands: [
        defineCommand("blocked", async () => {
          backgroundStarted = true;
          backgroundReady.resolve();
          await release.promise;
          return {
            stdout: "background\n",
            stderr: "background-err\n",
            exitCode: 0,
          };
        }),
        defineCommand("foreground", async () => {
          await backgroundReady.promise;
          expect(backgroundStarted).toBe(true);
          release.resolve();
          return {
            stdout: "foreground\n",
            stderr: "foreground-err\n",
            exitCode: 0,
          };
        }),
      ],
    });

    const result = await bash.exec("blocked & foreground; wait");

    expect(result).toMatchObject({
      stdout: "foreground\nbackground\n",
      stderr: "foreground-err\nbackground-err\n",
      exitCode: 0,
    });
  });

  it("assigns distinct job PIDs and child BASHPIDs", async () => {
    const result = await new Bash({ defenseInDepth: false }).exec(
      "{ echo child=$BASHPID; } & p1=$!; { echo child=$BASHPID; } & p2=$!; wait; echo jobs=$p1,$p2",
    );
    const lines = result.stdout.trim().split("\n");
    const childPids = lines.slice(0, 2).map((line) => Number(line.slice(6)));
    const jobPids = lines[2].slice(5).split(",").map(Number);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(new Set(jobPids).size).toBe(2);
    expect(jobPids.every((pid) => pid > 0)).toBe(true);
    expect(childPids).toEqual(jobPids);
  });

  it("isolates shell state while sharing filesystem effects", async () => {
    const bash = new Bash({ defenseInDepth: false });
    const result = await bash.exec(
      "x=parent; f() { echo parent-function; }; set +e; " +
        "{ x=child; cd /tmp; f() { echo child-function; }; set -e; echo shared > /job.txt; } & " +
        "wait; printf '%s|%s|' \"$x\" \"$PWD\"; f; cat /job.txt; set -o | grep '^errexit'",
    );

    expect(result.stdout).toBe(
      "parent|/home/user|parent-function\nshared\nerrexit         off\n",
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports nested jobs and a background AND/OR list", async () => {
    const result = await new Bash({ defenseInDepth: false }).exec(
      "{ { echo nested; } & wait; echo outer; } & " +
        "false || echo and-or & wait",
    );

    expect(result.stdout).toBe("and-or\nnested\nouter\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
