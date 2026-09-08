import { configDefaults, defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

const { test: harnessTests, ...vite } = viteConfig;
const unitFiles = ["src/**/*.test.ts", "shared/**/*.test.ts"];

export default defineConfig({
  ...vite,
  test: {
    // Bound the lightweight pool on small developer machines too. Each file
    // retains its own process, modules, environment and temporary home.
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          ...harnessTests,
          name: "unit",
          include: unitFiles,
          setupFiles: ["server/testing/setup-unit.ts"],
          fileParallelism: true,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          ...harnessTests,
          name: "harness",
          exclude: [...configDefaults.exclude, ...unitFiles],
          // Real servers and fake provider processes keep the established
          // serial execution, after the lightweight project has finished.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
