// Shared by both test projects, before any app module can resolve its data
// directory. Keep this module independent of the server/database imports.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTestHome(): string {
  const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Production overrides must not escape the throwaway home.
  delete process.env.OMB_DATA_DIR;
  delete process.env.HERMES_HOME;
  process.env.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");
  return home;
}
