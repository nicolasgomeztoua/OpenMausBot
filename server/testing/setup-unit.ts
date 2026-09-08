// Renderer and shared helpers do not use the server's SQLite store. They
// still get a fresh home and complete module/process isolation per file.
import { afterAll } from "vitest";
import { removeTempDir } from "./cleanup.ts";
import { createTestHome } from "./test-home.ts";

const home = createTestHome();
afterAll(() => removeTempDir(home));
