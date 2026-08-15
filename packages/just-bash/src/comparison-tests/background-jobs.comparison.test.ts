import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("Background jobs - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("waits for a PID and returns its status", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "false & pid=$!; wait $pid; echo status=$?",
    );
  });

  it("returns zero when wait has no jobs", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "wait; echo status=$?");
  });

  it("accepts wait -f", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "false & pid=$!; wait -f $pid; echo status=$?",
    );
  });

  it("wait -n selects the first completed named job", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "(sleep 0.03; exit 4) & slow=$!; " +
        "(sleep 0.001; exit 7) & fast=$!; " +
        "wait -n $slow $fast; echo first=$?; wait $slow; echo slow=$?",
    );
  });

  it("isolates shell variables while sharing filesystem effects", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "x=parent; { x=child; printf child > job.txt; } & wait; " +
        "printf '%s|' \"$x\"; cat job.txt",
    );
  });

  it("emits background output in completion order", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "{ sleep 0.03; echo slow; } & { sleep 0.001; echo fast; } & wait",
    );
  });
});
