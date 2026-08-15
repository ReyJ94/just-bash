import { cloneArrays } from "./helpers/array.js";
import type { CompletionSpec, InterpreterState, ShellArray } from "./types.js";

function cloneCompletionSpec(
  spec: CompletionSpec | undefined,
): CompletionSpec | undefined {
  return spec
    ? {
        ...spec,
        options: spec.options ? [...spec.options] : undefined,
        actions: spec.actions ? [...spec.actions] : undefined,
      }
    : undefined;
}

function cloneCompletionSpecs(
  specs: Map<string, CompletionSpec> | undefined,
): Map<string, CompletionSpec> | undefined {
  return specs
    ? new Map(
        Array.from(specs, ([name, spec]) => [
          name,
          cloneCompletionSpec(spec) as CompletionSpec,
        ]),
      )
    : undefined;
}

/**
 * Copy the fd alias groups, preserving the sharing structure: descriptors
 * that shared one Set in the original must share one Set in the copy, or the
 * subshell's reads would only move some of the aliases.
 */
function cloneFdAliases(
  aliases: Map<number, Set<number>> | undefined,
): Map<number, Set<number>> | undefined {
  if (!aliases) return undefined;
  const copiedGroups = new Map<Set<number>, Set<number>>();
  const cloned = new Map<number, Set<number>>();
  for (const [fd, group] of aliases) {
    let copy = copiedGroups.get(group);
    if (!copy) {
      copy = new Set(group);
      copiedGroups.set(group, copy);
    }
    cloned.set(fd, copy);
  }
  return cloned;
}

function cloneLocalArrayScopes(
  scopes: Map<string, ShellArray | undefined>[] | undefined,
): Map<string, ShellArray | undefined>[] | undefined {
  return scopes?.map(
    (scope) =>
      new Map(
        Array.from(scope, ([name, array]) => [
          name,
          array
            ? { kind: array.kind, elements: new Map(array.elements) }
            : undefined,
        ]),
      ),
  );
}

function cloneLocalVarStack(
  stack:
    | Map<string, Array<{ value: string | undefined; scopeIndex: number }>>
    | undefined,
): typeof stack {
  return stack
    ? new Map(
        Array.from(stack, ([name, entries]) => [
          name,
          entries.map((entry) => ({ ...entry })),
        ]),
      )
    : undefined;
}

/**
 * Produce a shell-namespace copy that can execute concurrently with its
 * parent. Host capabilities, execution accounting, and the virtual PID
 * allocator live outside (or are deliberately shared through) this state.
 */
export function cloneIsolatedShellState(
  state: InterpreterState,
): InterpreterState {
  return {
    ...state,
    env: new Map(state.env),
    arrays: cloneArrays(state.arrays),
    options: { ...state.options },
    shoptOptions: { ...state.shoptOptions },
    fileDescriptors: state.fileDescriptors
      ? new Map(state.fileDescriptors)
      : undefined,
    inputFds: state.inputFds ? new Set(state.inputFds) : undefined,
    fdAliases: cloneFdAliases(state.fdAliases),
    closedStandardFds: state.closedStandardFds
      ? new Set(state.closedStandardFds)
      : undefined,
    processSubstitutions: state.processSubstitutions
      ? [...state.processSubstitutions]
      : undefined,
    readonlyVars: new Set(state.readonlyVars),
    associativeArrays: new Set(state.associativeArrays),
    namerefs: new Set(state.namerefs),
    boundNamerefs: new Set(state.boundNamerefs),
    invalidNamerefs: new Set(state.invalidNamerefs),
    integerVars: new Set(state.integerVars),
    lowercaseVars: new Set(state.lowercaseVars),
    uppercaseVars: new Set(state.uppercaseVars),
    exportedVars: new Set(state.exportedVars),
    tempExportedVars: new Set(state.tempExportedVars),
    localExportedVars: state.localExportedVars?.map((vars) => new Set(vars)),
    declaredVars: new Set(state.declaredVars),
    localScopes: state.localScopes.map((scope) => new Map(scope)),
    localArrayScopes: cloneLocalArrayScopes(state.localArrayScopes),
    localVarDepth: state.localVarDepth
      ? new Map(state.localVarDepth)
      : undefined,
    localVarStack: cloneLocalVarStack(state.localVarStack),
    fullyUnsetLocals: state.fullyUnsetLocals
      ? new Map(state.fullyUnsetLocals)
      : undefined,
    tempEnvBindings: state.tempEnvBindings?.map(
      (bindings) => new Map(bindings),
    ),
    mutatedTempEnvVars: state.mutatedTempEnvVars
      ? new Set(state.mutatedTempEnvVars)
      : undefined,
    accessedTempEnvVars: state.accessedTempEnvVars
      ? new Set(state.accessedTempEnvVars)
      : undefined,
    functions: new Map(state.functions),
    callLineStack: state.callLineStack ? [...state.callLineStack] : undefined,
    funcNameStack: state.funcNameStack ? [...state.funcNameStack] : undefined,
    sourceStack: state.sourceStack ? [...state.sourceStack] : undefined,
    directoryStack: state.directoryStack
      ? [...state.directoryStack]
      : undefined,
    hashTable: state.hashTable ? new Map(state.hashTable) : undefined,
    completionSpecs: cloneCompletionSpecs(state.completionSpecs),
    defaultCompletionSpec: cloneCompletionSpec(state.defaultCompletionSpec),
    emptyCompletionSpec: cloneCompletionSpec(state.emptyCompletionSpec),
  };
}

/**
 * Install an isolated copy of mutable shell namespace state and return an
 * idempotent rollback. Process-wide accounting and PID allocation deliberately
 * remain shared with the parent execution.
 */
export function beginIsolatedShellState(state: InterpreterState): () => void {
  const saved = {
    env: state.env,
    arrays: state.arrays,
    cwd: state.cwd,
    previousDir: state.previousDir,
    lastExitCode: state.lastExitCode,
    lastArg: state.lastArg,
    currentLine: state.currentLine,
    options: state.options,
    shoptOptions: state.shoptOptions,
    fileDescriptors: state.fileDescriptors,
    inputFds: state.inputFds,
    fdAliases: state.fdAliases,
    closedStandardFds: state.closedStandardFds,
    nextFd: state.nextFd,
    readonlyVars: state.readonlyVars,
    associativeArrays: state.associativeArrays,
    namerefs: state.namerefs,
    boundNamerefs: state.boundNamerefs,
    invalidNamerefs: state.invalidNamerefs,
    integerVars: state.integerVars,
    lowercaseVars: state.lowercaseVars,
    uppercaseVars: state.uppercaseVars,
    exportedVars: state.exportedVars,
    tempExportedVars: state.tempExportedVars,
    localExportedVars: state.localExportedVars,
    declaredVars: state.declaredVars,
    localScopes: state.localScopes,
    localArrayScopes: state.localArrayScopes,
    localVarDepth: state.localVarDepth,
    localVarStack: state.localVarStack,
    fullyUnsetLocals: state.fullyUnsetLocals,
    tempEnvBindings: state.tempEnvBindings,
    mutatedTempEnvVars: state.mutatedTempEnvVars,
    accessedTempEnvVars: state.accessedTempEnvVars,
    functions: state.functions,
    callDepth: state.callDepth,
    sourceDepth: state.sourceDepth,
    callLineStack: state.callLineStack,
    funcNameStack: state.funcNameStack,
    sourceStack: state.sourceStack,
    currentSource: state.currentSource,
    inCondition: state.inCondition,
    loopDepth: state.loopDepth,
    parentHasLoopContext: state.parentHasLoopContext,
    errexitSafe: state.errexitSafe,
    directoryStack: state.directoryStack,
    hashTable: state.hashTable,
    completionSpecs: state.completionSpecs,
    defaultCompletionSpec: state.defaultCompletionSpec,
    emptyCompletionSpec: state.emptyCompletionSpec,
    groupStdin: state.groupStdin,
    groupStdinSourceFd: state.groupStdinSourceFd,
    bashPid: state.bashPid,
    expansionExitCode: state.expansionExitCode,
    expansionStderr: state.expansionStderr,
    lastBackgroundPid: state.lastBackgroundPid,
  };

  Object.assign(state, cloneIsolatedShellState(state));

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    Object.assign(state, saved);
  };
}
