import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("js-exec fs operations", () => {
  describe("readFile", () => {
    it.each([
      0,
      12,
      8 * 1024 * 1024,
      8 * 1024 * 1024 + 7,
    ])("reads all %i bytes through the built worker, without printing the source", async (size) => {
      const bytes = new Uint8Array(size).fill(65);
      if (size) bytes[size - 1] = 255;
      const env = new Bash({ javascript: true, files: { "/source": bytes } });
      const result = await env.exec(
        `js-exec -c 'const b = fs.readFileSync("/source", {encoding: null}); console.log(b.length, b.length ? b.slice(0, 1).toString("hex") : "empty", b.length ? b.slice(-1).toString("hex") : "empty");'`,
      );
      expect({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }).toEqual({
        stdout: size ? `${size} 41 ff\n` : "0 empty empty\n",
        stderr: "",
        exitCode: 0,
      });
    });

    it("decodes UTF-8 only after joining pieces across a character boundary", async () => {
      const prefix = "a".repeat(8 * 1024 * 1024 - 1);
      const env = new Bash({
        javascript: true,
        files: { "/source": `${prefix}€🙂tail` },
      });
      const result = await env.exec(
        `js-exec -c 'const s = fs.readFileSync("/source", "utf8"); console.log(s.length, s.slice(-7));'`,
      );
      expect({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }).toEqual({
        stdout: `${prefix.length + 7} €🙂tail\n`,
        stderr: "",
        exitCode: 0,
      });
    });

    it("should read a file", async () => {
      const env = new Bash({
        javascript: true,
        files: {
          "/home/user/test.txt": "hello world",
        },
      });
      const result = await env.exec(
        `js-exec -c "console.log(fs.readFileSync('/home/user/test.txt'))"`,
      );
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should throw on non-existent file", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "try { fs.readFileSync('/no/such/file'); } catch(e) { console.log('error: ' + e.message); }"`,
      );
      expect(result.stdout).toContain("error:");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("writeFile", () => {
    it("should write and read back a file", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "fs.writeFileSync('/tmp/out.txt', 'test data'); console.log(fs.readFileSync('/tmp/out.txt'))"`,
      );
      expect(result.stdout).toBe("test data\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("exists", () => {
    it("should return true for existing file", async () => {
      const env = new Bash({
        javascript: true,
        files: { "/home/user/file.txt": "data" },
      });
      const result = await env.exec(
        `js-exec -c "console.log(fs.existsSync('/home/user/file.txt'))"`,
      );
      expect(result.stdout).toBe("true\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return false for non-existing file", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "console.log(fs.existsSync('/no/such/file'))"`,
      );
      expect(result.stdout).toBe("false\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("stat", () => {
    it("should stat a file", async () => {
      const env = new Bash({
        javascript: true,
        files: { "/home/user/file.txt": "12345" },
      });
      const result = await env.exec(
        `js-exec -c "const s = fs.statSync('/home/user/file.txt'); console.log(s.isFile, s.size)"`,
      );
      expect(result.stdout).toBe("true 5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should stat a directory", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "const s = fs.statSync('/home'); console.log(s.isDirectory)"`,
      );
      expect(result.stdout).toBe("true\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("readdir", () => {
    it("should list directory entries", async () => {
      const env = new Bash({
        javascript: true,
        files: {
          "/home/user/a.txt": "a",
          "/home/user/b.txt": "b",
        },
      });
      const result = await env.exec(
        `js-exec -c "const entries = fs.readdirSync('/home/user'); console.log(JSON.stringify(entries.sort()))"`,
      );
      const entries = JSON.parse(result.stdout.trim());
      expect(entries).toContain("a.txt");
      expect(entries).toContain("b.txt");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("mkdir", () => {
    it("should create a directory", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "fs.mkdirSync('/tmp/newdir'); console.log(fs.existsSync('/tmp/newdir'))"`,
      );
      expect(result.stdout).toBe("true\n");
      expect(result.exitCode).toBe(0);
    });

    it("should create directories recursively", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "fs.mkdirSync('/tmp/a/b/c', {recursive: true}); console.log(fs.existsSync('/tmp/a/b/c'))"`,
      );
      expect(result.stdout).toBe("true\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("rm", () => {
    it("should remove a file", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "fs.writeFileSync('/tmp/del.txt', 'x'); fs.rmSync('/tmp/del.txt'); console.log(fs.existsSync('/tmp/del.txt'))"`,
      );
      expect(result.stdout).toBe("false\n");
      expect(result.exitCode).toBe(0);
    });

    it("should remove directory recursively", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "fs.mkdirSync('/tmp/rmdir'); fs.writeFileSync('/tmp/rmdir/f.txt', 'x'); fs.rmSync('/tmp/rmdir', {recursive: true}); console.log(fs.existsSync('/tmp/rmdir'))"`,
      );
      expect(result.stdout).toBe("false\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("appendFile", () => {
    it("should append to a file", async () => {
      const env = new Bash({ javascript: true });
      const result = await env.exec(
        `js-exec -c "fs.writeFileSync('/tmp/app.txt', 'hello'); fs.appendFileSync('/tmp/app.txt', ' world'); console.log(fs.readFileSync('/tmp/app.txt'))"`,
      );
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
