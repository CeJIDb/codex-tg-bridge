#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const BRANCH_REGEX = /^(feature|docs|chore|hotfix)\/[a-z0-9._-]+$/;

function getGitDir() {
  const gitPath = path.resolve(".git");
  if (lstatSync(gitPath).isDirectory()) {
    return gitPath;
  }

  const gitMetadata = readFileSync(gitPath, "utf-8");

  if (gitMetadata.startsWith("gitdir:")) {
    const gitDir = gitMetadata.slice("gitdir:".length).trim();
    return path.resolve(gitDir);
  }

  return gitPath;
}

function getBranchName() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;

  const headPath = path.join(getGitDir(), "HEAD");
  const headContent = readFileSync(headPath, "utf-8").trim();

  if (headContent.startsWith("ref:")) {
    return headContent
      .slice("ref:".length)
      .trim()
      .replace(/^refs\/heads\//, "");
  }

  return headContent;
}

function isProtectedBranch(branchName) {
  return branchName === "main" || branchName === "master";
}

function main() {
  const branchName = getBranchName();

  if (isProtectedBranch(branchName)) {
    console.log(`Branch '${branchName}' is allowed as protected branch.`);
    return;
  }

  if (!BRANCH_REGEX.test(branchName)) {
    console.error(
      `Invalid branch name '${branchName}'. Use: feature/*, docs/*, chore/*, hotfix/* with lowercase latin symbols.`,
    );
    process.exit(1);
  }

  console.log(`Branch name '${branchName}' matches policy.`);
}

main();
