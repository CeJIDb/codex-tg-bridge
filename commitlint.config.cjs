module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "chore", "refactor", "test", "ci", "build", "perf", "revert"],
    ],
    "header-max-length": [2, "always", 100],
  },
};
