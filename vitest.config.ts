import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["spec/**/*.spec.ts"],
    // the matchers read vitest's globals (`describe`) when they are provided
    globals: true,
    // spec files that use the database would clean each other's rows if they
    // ran at the same time
    fileParallelism: false,
  },
})
