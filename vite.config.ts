import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["drizzle/**", "app/build/**", "app/dist/**"],
    plugins: ["typescript", "import", "unicorn", "oxc"],
    categories: { correctness: "error", suspicious: "error" },
    rules: {
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "import/no-duplicates": "error",
      "eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
    // Test fakes stand in for only the parts of OpenCode's APIs the code under test uses.
    overrides: [
      {
        files: ["test/**", "app/test/**"],
        rules: { "typescript/no-unsafe-type-assertion": "off" },
      },
    ],
  },
  fmt: {
    ignorePatterns: ["drizzle/**", "app/build/**", "app/dist/**"],
  },
});
