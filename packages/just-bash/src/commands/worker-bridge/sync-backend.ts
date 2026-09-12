/**
 * Worker-side synchronous backend
 *
 * Runs in the worker thread and makes synchronous calls to the main thread
 * via SharedArrayBuffer + Atomics.
 */

import { _performanceNow } from "../../security/trusted-globals.js";
import {
  Flags,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  Status,
} from "./protocol.js";

/**
 * Synchronous backend for worker threads.
 */
export class SyncBackend {
  private protocol: ProtocolBuffer;
  private operationTimeoutMs: number;
  private closed = false;

  constructor(sharedBuffer: SharedArrayBuffer, operationTimeoutMs = 30000) {
    this.protocol = new ProtocolBuffer(sharedBuffer);
    this.operationTimeoutMs = operationTimeoutMs;
  }

  private execSync(
    opCode: OpCodeType,
    path: string,
    data?: Uint8Array,
    flags = 0,
    mode = 0,
    deadline = _performanceNow() + this.operationTimeoutMs,
    read?: { offset: number; total: number },
  ): { success: boolean; result?: Uint8Array; error?: string } {
    if (this.closed || this.protocol.getStatus() === Status.CLOSED) {
      return { success: false, error: "Bridge is closed" };
    }
    const remaining = deadline - _performanceNow();
    if (remaining <= 0) {
      this.close();
      return { success: false, error: "Operation timed out" };
    }
    this.protocol.reset();
    this.protocol.setOpCode(opCode);
    this.protocol.setPath(path);
    this.protocol.setFlags(flags);
    this.protocol.setMode(mode);
    if (read) {
      this.protocol.setReadOffset(read.offset);
      this.protocol.setReadTotalLength(read.total);
    }
    if (data) {
      this.protocol.setData(data);
    }

    this.protocol.setStatus(Status.READY);
    this.protocol.notify();

    // Wait for main thread to process (with timeout)
    const waitResult = this.protocol.waitForResult(remaining);
    if (waitResult === "timed-out") {
      this.close();
      return { success: false, error: "Operation timed out" };
    }

    const status = this.protocol.getStatus();
    if (status === Status.SUCCESS) {
      // File piece copying/allocation belongs inside readFile's abort boundary.
      if (opCode === OpCode.READ_FILE || opCode === OpCode.READ_FILE_NEXT) {
        return { success: true };
      }
      return { success: true, result: this.protocol.getResult() };
    }
    if (status !== Status.ERROR) {
      this.close();
      return { success: false, error: "Bridge is closed" };
    }
    return {
      success: false,
      error:
        this.protocol.getResultAsString() ||
        `Error code: ${this.protocol.getErrorCode()}`,
    };
  }

  private close(): void {
    this.closed = true;
    this.protocol.close();
  }

  readFile(path: string): Uint8Array {
    const deadline = _performanceNow() + this.operationTimeoutMs;
    let began = false;
    try {
      const first = this.execSync(
        OpCode.READ_FILE,
        path,
        undefined,
        0,
        0,
        deadline,
      );
      if (!first.success) throw new Error(first.error || "Failed to read file");
      began = true;
      const total = this.protocol.getReadTotalLength();
      const bytes = new Uint8Array(total);
      let offset = 0;
      while (true) {
        const length = this.protocol.getResultLength();
        if (
          this.protocol.getReadTotalLength() !== total ||
          length < 0 ||
          length > this.protocol.getResultCapacity() ||
          length > total - offset ||
          (length === 0 && offset < total)
        ) {
          throw new Error("Invalid file read piece");
        }
        bytes.set(this.protocol.getResult(), offset);
        offset += length;
        if (offset === total) return bytes;
        const next = this.execSync(
          OpCode.READ_FILE_NEXT,
          "",
          undefined,
          0,
          0,
          deadline,
          { offset, total },
        );
        if (!next.success) throw new Error(next.error || "Failed to read file");
      }
    } catch (error) {
      if (began && !this.closed) {
        try {
          const aborted = this.execSync(
            OpCode.READ_FILE_ABORT,
            "",
            undefined,
            0,
            0,
            deadline,
          );
          if (!aborted.success) this.close();
        } catch {
          this.close();
        }
      }
      throw error;
    }
  }

  writeFile(path: string, data: Uint8Array): void {
    const result = this.execSync(OpCode.WRITE_FILE, path, data);
    if (!result.success) {
      throw new Error(result.error || "Failed to write file");
    }
  }

  stat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    const result = this.execSync(OpCode.STAT, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to stat");
    }
    return this.protocol.decodeStat();
  }

  lstat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    const result = this.execSync(OpCode.LSTAT, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to lstat");
    }
    return this.protocol.decodeStat();
  }

  readdir(path: string): string[] {
    const result = this.execSync(OpCode.READDIR, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to readdir");
    }
    return JSON.parse(this.protocol.getResultAsString());
  }

  mkdir(path: string, recursive = false): void {
    const flags = recursive ? Flags.MKDIR_RECURSIVE : 0;
    const result = this.execSync(OpCode.MKDIR, path, undefined, flags);
    if (!result.success) {
      throw new Error(result.error || "Failed to mkdir");
    }
  }

  rm(path: string, recursive = false, force = false): void {
    let flags = 0;
    if (recursive) flags |= Flags.RECURSIVE;
    if (force) flags |= Flags.FORCE;
    const result = this.execSync(OpCode.RM, path, undefined, flags);
    if (!result.success) {
      throw new Error(result.error || "Failed to rm");
    }
  }

  exists(path: string): boolean {
    const result = this.execSync(OpCode.EXISTS, path);
    if (!result.success) {
      return false;
    }
    return result.result?.[0] === 1;
  }

  appendFile(path: string, data: Uint8Array): void {
    const result = this.execSync(OpCode.APPEND_FILE, path, data);
    if (!result.success) {
      throw new Error(result.error || "Failed to append file");
    }
  }

  symlink(target: string, linkPath: string): void {
    const targetData = new TextEncoder().encode(target);
    const result = this.execSync(OpCode.SYMLINK, linkPath, targetData);
    if (!result.success) {
      throw new Error(result.error || "Failed to symlink");
    }
  }

  readlink(path: string): string {
    const result = this.execSync(OpCode.READLINK, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to readlink");
    }
    return this.protocol.getResultAsString();
  }

  chmod(path: string, mode: number): void {
    const result = this.execSync(OpCode.CHMOD, path, undefined, 0, mode);
    if (!result.success) {
      throw new Error(result.error || "Failed to chmod");
    }
  }

  realpath(path: string): string {
    const result = this.execSync(OpCode.REALPATH, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to realpath");
    }
    return this.protocol.getResultAsString();
  }

  rename(oldPath: string, newPath: string): void {
    const newPathData = new TextEncoder().encode(newPath);
    const result = this.execSync(OpCode.RENAME, oldPath, newPathData);
    if (!result.success) {
      throw new Error(result.error || "Failed to rename");
    }
  }

  copyFile(src: string, dest: string): void {
    const destData = new TextEncoder().encode(dest);
    const result = this.execSync(OpCode.COPY_FILE, src, destData);
    if (!result.success) {
      throw new Error(result.error || "Failed to copyFile");
    }
  }

  writeStdout(data: string): void {
    const encoded = new TextEncoder().encode(data);
    const result = this.execSync(OpCode.WRITE_STDOUT, "", encoded);
    if (!result.success) {
      throw new Error(result.error || "Failed to write stdout");
    }
  }

  writeStderr(data: string): void {
    const encoded = new TextEncoder().encode(data);
    const result = this.execSync(OpCode.WRITE_STDERR, "", encoded);
    if (!result.success) {
      throw new Error(result.error || "Failed to write stderr");
    }
  }

  exit(code: number): void {
    this.execSync(OpCode.EXIT, "", undefined, code);
  }

  /**
   * Make an HTTP request through the main thread's secureFetch.
   * Returns the response as a parsed object.
   */
  httpRequest(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bodyBase64: string;
    url: string;
  } {
    const requestData = options
      ? new TextEncoder().encode(JSON.stringify(options))
      : undefined;
    const result = this.execSync(OpCode.HTTP_REQUEST, url, requestData);
    if (!result.success) {
      throw new Error(result.error || "HTTP request failed");
    }
    const responseJson = new TextDecoder().decode(result.result);
    const parsed = JSON.parse(responseJson) as {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      url: string;
      bodyBase64: string;
    };
    const bodyBase64 = parsed.bodyBase64 ?? "";
    const body = atob(bodyBase64);
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      url: parsed.url,
      body,
      bodyBase64,
    };
  }

  /**
   * Execute a shell command through the main thread's exec function.
   * Returns the result as { stdout, stderr, exitCode }.
   */
  execCommand(
    command: string,
    stdin?: string,
  ): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const requestData = stdin
      ? new TextEncoder().encode(JSON.stringify({ stdin }))
      : undefined;
    const result = this.execSync(OpCode.EXEC_COMMAND, command, requestData);
    if (!result.success) {
      throw new Error(result.error || "Command execution failed");
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }

  /**
   * Execute a shell command with structured args (shell-escaped on the main thread).
   * Prevents command injection from unsanitized args.
   */
  execCommandArgs(
    command: string,
    args: string[],
  ): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const requestData = new TextEncoder().encode(JSON.stringify({ args }));
    const result = this.execSync(OpCode.EXEC_COMMAND, command, requestData);
    if (!result.success) {
      throw new Error(result.error || "Command execution failed");
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }
}
