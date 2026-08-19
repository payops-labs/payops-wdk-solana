export function assertBetaReleaseTag(tag, packageVersion) {
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/u.test(packageVersion)) {
    throw new Error("Package version must be a numbered beta release");
  }

  if (tag !== `v${packageVersion}`) {
    throw new Error("Release tag must exactly match the package version");
  }
}
