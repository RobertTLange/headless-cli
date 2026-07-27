import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const changelog = readFileSync("CHANGELOG.md", "utf8");
const npmPackage = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const pythonProject = readFileSync("python/pyproject.toml", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");

const pythonVersion = pythonProject.match(/^version = "([^"]+)"$/m)?.[1];

test("npm, PyPI, and changelog release versions agree", () => {
  assert.equal(pythonVersion, npmPackage.version);
  assert.match(changelog, new RegExp(`^## ${npmPackage.version} - \\d{4}-\\d{2}-\\d{2}$`, "m"));
});

test("release workflow validates package and tag versions before publishing", () => {
  const validationIndex = releaseWorkflow.indexOf("validate-release:");
  const npmPublishIndex = releaseWorkflow.indexOf("publish-npm:");
  const pythonBuildIndex = releaseWorkflow.indexOf("build-python:");
  const npmPublishBlock = releaseWorkflow.slice(npmPublishIndex, pythonBuildIndex);

  assert.notEqual(validationIndex, -1);
  assert.ok(validationIndex < npmPublishIndex);
  assert.ok(validationIndex < pythonBuildIndex);
  assert.match(npmPublishBlock, /needs:\s+- validate-release\s+- build-python/);
  assert.match(releaseWorkflow, /build-python:[\s\S]*?needs: validate-release/);
  assert.match(releaseWorkflow, /on:\s+release:\s+types:\s+- published/);
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch:/);
  assert.match(releaseWorkflow, /npm_version != python_version/);
  assert.match(releaseWorkflow, /release_tag != f"v\{npm_version\}"/);
});

test("release workflow pins actions and publishes npm with provenance", () => {
  const actionReferences = [...releaseWorkflow.matchAll(/^\s+uses:\s+([^@\s]+)@(\S+)(?:\s+#.*)?$/gm)];

  assert.equal(actionReferences.length, 9);
  for (const [, action, revision] of actionReferences) {
    assert.match(revision ?? "", /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
  }
  assert.match(releaseWorkflow, /id-token: write/);
  assert.match(releaseWorkflow, /environment: npm/);
  assert.match(
    releaseWorkflow,
    /npm publish --access public --provenance --tag "release-\$PACKAGE_VERSION"/,
  );
});

test("release workflow serializes publishing and fails closed on npm lookup errors", () => {
  assert.match(
    releaseWorkflow,
    /concurrency:\s+group: package-release\s+cancel-in-progress: false\s+queue: max/,
  );
  assert.match(releaseWorkflow, /elif grep -q "E404" "\$npm_error"; then/);
  assert.match(releaseWorkflow, /cat "\$npm_error" >&2\s+exit 1/);
});

test("release workflow only moves npm latest to the freshest GitHub release", () => {
  assert.match(
    releaseWorkflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/latest" --jq \.tag_name/,
  );
  assert.match(releaseWorkflow, /"\$RELEASE_TAG" != "\$latest_release_tag"/);
  assert.match(
    releaseWorkflow,
    /npm dist-tag add "@roberttlange\/headless@\$PACKAGE_VERSION" latest/,
  );
});
