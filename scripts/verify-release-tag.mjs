import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { assertBetaReleaseTag } from "./release-lib.mjs";

const tag = process.argv[2];

if (tag === undefined) {
  throw new Error("Usage: node scripts/verify-release-tag.mjs <tag>");
}

const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

assertBetaReleaseTag(tag, packageManifest.version);

const headCommit = git("rev-parse", "HEAD");
const taggedCommit = git("rev-parse", `${tag}^{commit}`);

if (headCommit !== taggedCommit) {
  throw new Error("Release tag must point to the checked-out commit");
}

if (git("status", "--porcelain") !== "") {
  throw new Error("Release checkout must be clean");
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}
