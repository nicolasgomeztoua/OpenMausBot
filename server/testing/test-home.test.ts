import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestHome } from "./test-home.ts";

it("isolates every home and overrides inherited app data paths without initializing the server", () => {
  const keys = ["HOME", "USERPROFILE", "OMB_DATA_DIR", "HERMES_HOME", "OMB_COMPANION_DIR"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const homes: string[] = [];
  try {
    process.env.OMB_DATA_DIR = join(homedir(), "inherited-data");
    process.env.HERMES_HOME = join(homedir(), "inherited-hermes");
    process.env.OMB_COMPANION_DIR = join(homedir(), "inherited-companion");

    for (let i = 0; i < 2; i += 1) {
      const home = createTestHome();
      homes.push(home);
      expect(homedir()).toBe(home);
      expect(process.env.HOME).toBe(home);
      expect(process.env.USERPROFILE).toBe(home);
      expect(process.env.OMB_DATA_DIR).toBeUndefined();
      expect(process.env.HERMES_HOME).toBeUndefined();
      expect(process.env.OMB_COMPANION_DIR).toBe(join(home, ".openmausbot-companion"));
      expect(existsSync(home)).toBe(true);
      expect(existsSync(join(home, ".openmausbot"))).toBe(false);
    }
    expect(homes[0]).not.toBe(homes[1]);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});
