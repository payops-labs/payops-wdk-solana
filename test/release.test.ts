import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { assertBetaReleaseTag } from "../scripts/release-lib.mjs";

const repositoryRoot = new URL("../", import.meta.url);

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

describe("public beta release", () => {
  test("publishes the package with the expected public identity", async () => {
    const packageManifest = JSON.parse(
      await readRepositoryFile("package.json"),
    );

    expect(packageManifest).toMatchObject({
      name: "@payops/wdk-solana",
      version: "0.1.0-beta.1",
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "https://github.com/payops-labs/payops-wdk-solana.git",
      },
      homepage: "https://github.com/payops-labs/payops-wdk-solana#readme",
      bugs: {
        url: "https://github.com/payops-labs/payops-wdk-solana/issues",
      },
      publishConfig: {
        access: "public",
        provenance: true,
        tag: "beta",
      },
    });
    expect(packageManifest.private).toBeUndefined();
  });

  test("uses a protected trusted-publishing workflow for beta tags", async () => {
    const workflow = await readRepositoryFile(".github/workflows/release.yml");

    expect(workflow).toContain('      - "v*-beta.*"');
    expect(workflow).toContain("environment: npm-release");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("pnpm release:verify");
    expect(workflow).toContain("node scripts/verify-release-tag.mjs");
    expect(workflow).toContain("npm publish");
    expect(workflow).not.toContain("NPM_TOKEN");
  });

  test("requires the Git tag to exactly match a beta package version", () => {
    expect(() =>
      assertBetaReleaseTag("v0.1.0-beta.1", "0.1.0-beta.1"),
    ).not.toThrow();
    expect(() => assertBetaReleaseTag("v0.1.0", "0.1.0")).toThrow(/beta/u);
    expect(() => assertBetaReleaseTag("v0.1.0-beta.2", "0.1.0-beta.1")).toThrow(
      /match/u,
    );
  });

  test("runs dependency review and CodeQL with bounded permissions", async () => {
    const [ci, codeql] = await Promise.all([
      readRepositoryFile(".github/workflows/ci.yml"),
      readRepositoryFile(".github/workflows/codeql.yml"),
    ]);

    expect(ci).toContain("dependency-review-action");
    expect(ci).toContain("fail-on-severity: moderate");
    expect(codeql).toContain("security-events: write");
    expect(codeql).toContain("queries: security-extended");
  });
});
