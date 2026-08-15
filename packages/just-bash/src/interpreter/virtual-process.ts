import type { InterpreterState } from "./types.js";

/** Allocate a unique virtual process ID across isolated concurrent shell copies. */
export function allocateVirtualPid(state: InterpreterState): number {
  let allocator = state.virtualPidAllocator;
  if (!allocator) {
    allocator = { next: state.nextVirtualPid };
    state.virtualPidAllocator = allocator;
  }
  const pid = allocator.next++;
  // Preserve the historical counter field for internal consumers that inspect
  // state, while the shared object remains the concurrency-safe authority.
  state.nextVirtualPid = allocator.next;
  return pid;
}
