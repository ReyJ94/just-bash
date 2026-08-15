import { ExecutionOutputAccumulator } from "../execution-output.js";
import type { ExecutionScope } from "../execution-scope.js";
import type { ExecResult } from "../types.js";
import { ControlFlowError, ExecutionLimitError } from "./errors.js";
import { failure, OK } from "./helpers/result.js";

interface JobOutcome {
  readonly pid: number;
  readonly completionOrder: number;
  readonly result?: ExecResult;
  readonly error?: unknown;
}

interface BackgroundJob {
  readonly pid: number;
  readonly completion: Promise<JobOutcome>;
  outcome?: JobOutcome;
  outputEmitted: boolean;
  waited: boolean;
}

const WAIT_USAGE = "wait: usage: wait [-fn] [id ...]\n";

export class BackgroundJobController {
  private readonly jobs = new Map<number, BackgroundJob>();
  private readonly completionQueue: JobOutcome[] = [];
  private activeJobs = 0;
  private completionSequence = 0;

  constructor(
    private readonly executionScope: ExecutionScope,
    private readonly maxConcurrentJobs: number,
    private readonly allocatePid: () => number,
  ) {}

  launch(run: (pid: number) => Promise<ExecResult>): number {
    if (this.activeJobs >= this.maxConcurrentJobs) {
      const error = new ExecutionLimitError(
        `maximum concurrent background jobs exceeded (${this.maxConcurrentJobs})`,
        "iterations",
      );
      this.executionScope.poisonAfterLimit(error);
      throw error;
    }

    const pid = this.allocatePid();
    this.activeJobs++;
    const job = {} as BackgroundJob;
    const completion = Promise.resolve()
      .then(() => run(pid))
      .then(
        (result): JobOutcome => ({
          pid,
          result,
          completionOrder: this.completionSequence++,
        }),
        (error: unknown): JobOutcome => ({
          pid,
          error,
          completionOrder: this.completionSequence++,
        }),
      )
      .then((outcome) => {
        this.activeJobs--;
        job.outcome = outcome;
        this.completionQueue.push(outcome);
        return outcome;
      });
    Object.assign(job, {
      pid,
      completion,
      outputEmitted: false,
      waited: false,
    });
    this.jobs.set(pid, job);
    return pid;
  }

  takeCompletedOutput(): ExecResult {
    return this.collectOutcomes(this.completionQueue.splice(0));
  }

  async drainAll(): Promise<ExecResult> {
    await Promise.all(Array.from(this.jobs.values(), (job) => job.completion));
    return this.takeCompletedOutput();
  }

  async wait(args: string[]): Promise<ExecResult> {
    let waitNext = false;
    const ids: string[] = [];
    let parseOptions = true;
    for (const arg of args) {
      if (parseOptions && arg === "--") {
        parseOptions = false;
        continue;
      }
      if (parseOptions && arg.startsWith("-") && arg !== "-") {
        for (const option of arg.slice(1)) {
          if (option === "n") waitNext = true;
          else if (option !== "f") {
            return failure(
              `bash: wait: -${option}: invalid option\n${WAIT_USAGE}`,
              2,
            );
          }
        }
        continue;
      }
      ids.push(arg);
    }

    const selected: BackgroundJob[] = [];
    for (const id of ids) {
      if (!/^\d+$/.test(id)) {
        return failure(
          `bash: wait: \`${id}': not a pid or valid job spec\n`,
          127,
        );
      }
      const pid = Number(id);
      const job = this.jobs.get(pid);
      if (!job) {
        return failure(
          `bash: wait: pid ${id} is not a child of this shell\n`,
          127,
        );
      }
      selected.push(job);
    }

    if (waitNext) {
      const candidates = (
        selected.length > 0 ? selected : Array.from(this.jobs.values())
      ).filter((job) => !job.waited);
      if (candidates.length === 0) return failure("", 127);
      const alreadyComplete = candidates
        .filter((job) => job.outcome)
        .sort(
          (left, right) =>
            (left.outcome?.completionOrder ?? 0) -
            (right.outcome?.completionOrder ?? 0),
        )[0];
      const outcome = alreadyComplete
        ? (alreadyComplete.outcome as JobOutcome)
        : await Promise.race(candidates.map((job) => job.completion));
      const completed = this.jobs.get(outcome.pid) as BackgroundJob;
      completed.waited = true;
      const output = this.takeCompletedOutput();
      this.throwOutcomeError(outcome, output);
      return { ...output, exitCode: outcome.result?.exitCode ?? 1 };
    }

    if (selected.length === 0) {
      const jobs = Array.from(this.jobs.values());
      await Promise.all(jobs.map((job) => job.completion));
      for (const job of jobs) job.waited = true;
      return { ...this.takeCompletedOutput(), exitCode: 0 };
    }

    let exitCode = 0;
    for (const job of selected) {
      const outcome = await job.completion;
      job.waited = true;
      exitCode = outcome.result?.exitCode ?? 1;
    }
    const output = this.takeCompletedOutput();
    for (const job of selected) {
      if (job.outcome) this.throwOutcomeError(job.outcome, output);
    }
    return { ...output, exitCode };
  }

  private collectOutcomes(outcomes: JobOutcome[]): ExecResult {
    if (outcomes.length === 0) return OK;
    outcomes.sort(
      (left, right) => left.completionOrder - right.completionOrder,
    );
    const output = new ExecutionOutputAccumulator(
      this.executionScope,
      "background jobs",
    );
    for (const outcome of outcomes) {
      const job = this.jobs.get(outcome.pid);
      if (!job || job.outputEmitted) continue;
      job.outputEmitted = true;
      if (outcome.result) output.appendResult(outcome.result);
      else this.throwOutcomeError(outcome, output.build(1));
    }
    return output.build(0);
  }

  private throwOutcomeError(outcome: JobOutcome, prior: ExecResult): void {
    if (outcome.error === undefined) return;
    if (outcome.error instanceof ControlFlowError) {
      outcome.error.prependOutput(prior.stdout, prior.stderr);
    }
    throw outcome.error;
  }
}
