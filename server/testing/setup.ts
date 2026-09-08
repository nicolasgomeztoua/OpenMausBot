// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.openmausbot) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";
import { createTestHome } from "./test-home.ts";

const home = createTestHome();

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// Windows holds a directory that is a live process's cwd, and a just-killed
// CLI lets go a beat after the kill call returns — see removeTempDir.
afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
