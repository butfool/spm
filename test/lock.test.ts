import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spmHome } from "../src/config.js";
import { acquireLock, releaseLock } from "../src/core/lock.js";
import { clearHome, useTempHome } from "./helpers.js";

beforeEach(() => {
  useTempHome();
});

afterEach(() => {
  releaseLock();
  clearHome();
});

function lockFile(): string {
  return path.join(spmHome(), ".lock");
}

function writeLock(contents: string): void {
  fs.mkdirSync(spmHome(), { recursive: true });
  fs.writeFileSync(lockFile(), contents, "utf8");
}

describe("the machine-level write lock", () => {
  it("records the holder and releases it", () => {
    acquireLock();
    expect(fs.readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));

    releaseLock();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("refuses a lock another live process holds", () => {
    writeLock(`${process.pid}\n`);
    expect(() => acquireLock()).toThrow(/another spm process/);
  });

  it("takes over a lock whose process is gone", () => {
    writeLock("999999\n");
    acquireLock();
    expect(fs.readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
  });

  it("takes over an empty lock left by a crash", () => {
    writeLock("");
    acquireLock();
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it("releasing without holding is a no-op", () => {
    expect(() => releaseLock()).not.toThrow();
  });
});
