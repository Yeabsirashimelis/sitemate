import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";

describe("local database lock", () => {
  const root = mkdtempSync(join(tmpdir(), "sitemate-lock-"));
  const dir = join(root, "pglite");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses to open a folder another live process is using", async () => {
    // The parent process (the test runner) is alive and is not us.
    writeFileSync(`${dir}.lock`, String(process.ppid));
    await expect(openDatabase({ pgliteDir: dir })).rejects.toThrow(/in use by process/);
  });

  it("takes over a lock left by a process that has died, and releases it on close", async () => {
    writeFileSync(`${dir}.lock`, "2147483646");
    const handle = await openDatabase({ pgliteDir: dir });
    expect(readFileSync(`${dir}.lock`, "utf8")).toBe(String(process.pid));
    await handle.close();
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });
});
