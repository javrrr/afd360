import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          // Skip integration tests unless an org alias is provided.
          // M12 wires a real scratch org via this var in CI.
          ...(process.env.AFD360_TEST_ORG ? {} : { exclude: ["**/*"] }),
        },
      },
    ],
  },
});
