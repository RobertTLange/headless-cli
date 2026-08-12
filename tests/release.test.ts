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
  const npmBuildIndex = releaseWorkflow.indexOf("build-npm:");
  const npmPublishIndex = releaseWorkflow.indexOf("publish-npm:");
  const pythonBuildIndex = releaseWorkflow.indexOf("build-python:");
  const npmPublishBlock = releaseWorkflow.slice(npmPublishIndex, pythonBuildIndex);

  assert.notEqual(validationIndex, -1);
  assert.ok(validationIndex < npmBuildIndex);
  assert.ok(validationIndex < npmPublishIndex);
  assert.ok(validationIndex < pythonBuildIndex);
  assert.match(
    npmPublishBlock,
    /needs:\s+- validate-release\s+- build-npm\s+- build-python/,
  );
  assert.match(releaseWorkflow, /build-npm:[\s\S]*?needs: validate-release/);
  assert.match(releaseWorkflow, /build-python:[\s\S]*?needs: validate-release/);
  assert.match(releaseWorkflow, /on:\s+release:\s+types:\s+- published/);
  assert.match(releaseWorkflow, /npm_version != python_version/);
  assert.match(releaseWorkflow, /release_tag != f"v\{npm_version\}"/);
  assert.equal(releaseWorkflow.match(/ref: \$\{\{ github\.sha \}\}/g)?.length, 1);
  assert.equal(
    releaseWorkflow.match(/ref: \$\{\{ needs\.validate-release\.outputs\.release-sha \}\}/g)
      ?.length,
    3,
  );
  assert.match(
    releaseWorkflow,
    /package-version: \$\{\{ steps\.versions\.outputs\.version \}\}/,
  );
  assert.match(releaseWorkflow, /release-sha: \$\{\{ steps\.release-sha\.outputs\.value \}\}/);
});

test("PyPI recovery reuses artifacts from the matching immutable release run", () => {
  assert.match(
    releaseWorkflow,
    /workflow_dispatch:\s+inputs:\s+release_tag:[\s\S]*?source_run_id:/,
  );
  assert.match(
    releaseWorkflow,
    /recover-pypi:[\s\S]*?if: github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(releaseWorkflow, /environment:\s+name: pypi/);
  assert.match(releaseWorkflow, /actions: read/);
  assert.match(releaseWorkflow, /run-id: \$\{\{ inputs\.source_run_id \}\}/);
  assert.match(releaseWorkflow, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(releaseWorkflow, /source\["workflow_id"\] != workflow\["id"\]/);
  assert.match(releaseWorkflow, /source\["path"\] != workflow\["path"\]/);
  assert.match(releaseWorkflow, /workflow\["path"\] != "\.github\/workflows\/release\.yml"/);
  assert.match(releaseWorkflow, /source\["event"\] != "release"/);
  assert.match(releaseWorkflow, /source\["head_sha"\] != tag_sha/);
  assert.match(releaseWorkflow, /tag-sha=\{tag_sha\}/);
  assert.match(releaseWorkflow, /release\["draft"\] or release\["prerelease"\]/);
  assert.match(releaseWorkflow, /release\["tag_name"\] != release_tag/);
  assert.match(releaseWorkflow, /headless_cli-\{version\}-py3-none-any\.whl/);
  assert.match(releaseWorkflow, /headless_cli-\{version\}\.tar\.gz/);
});

test("release workflow pins actions and publishes npm with provenance", () => {
  const actionReferences = [...releaseWorkflow.matchAll(/^\s+uses:\s+([^@\s]+)@(\S+)(?:\s+#.*)?$/gm)];

  assert.equal(actionReferences.length, 15);
  for (const [, action, revision] of actionReferences) {
    assert.match(revision ?? "", /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
  }
  assert.match(releaseWorkflow, /id-token: write/);
  assert.match(releaseWorkflow, /environment: npm/);
  assert.match(releaseWorkflow, /node-version: 24\.18\.0/);
  assert.match(releaseWorkflow, /test "\$\(npm --version\)" = "11\.16\.0"/);
  assert.doesNotMatch(releaseWorkflow, /npm install --global npm/);
  assert.doesNotMatch(releaseWorkflow, /NODE_AUTH_TOKEN/);
  assert.match(
    releaseWorkflow,
    /npm publish "\$TARBALL_PATH" --registry https:\/\/registry\.npmjs\.org\/ \\\s+--access public --provenance --tag "\$npm_tag"/,
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

test("release workflow only publishes npm latest for the freshest GitHub release", () => {
  assert.match(
    releaseWorkflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/latest" --jq \.tag_name/,
  );
  assert.match(releaseWorkflow, /npm_tag="release-\$PACKAGE_VERSION"/);
  assert.match(releaseWorkflow, /"\$RELEASE_TAG" == "\$latest_release_tag"/);
  assert.match(releaseWorkflow, /npm_tag=latest/);
});

test("PyPI waits for npm preflight but not npm publication success", () => {
  const pypiIndex = releaseWorkflow.indexOf("publish-pypi:");
  const pypiBlock = releaseWorkflow.slice(pypiIndex);

  assert.match(
    releaseWorkflow,
    /publish-pypi:\s+name: Publish Python SDK to PyPI\s+needs:\s+- validate-release\s+- build-npm\s+- build-python/,
  );
  assert.match(releaseWorkflow, /always\(\) &&\s+needs\.build-python\.result == 'success'/);
  assert.match(releaseWorkflow, /needs\.build-npm\.result == 'success'/);
  assert.match(releaseWorkflow, /needs\.build-npm\.outputs\.verified == 'true'/);
  assert.match(pypiBlock, /permissions:\s+contents: read\s+id-token: write/);
});

test("npm OIDC is isolated from package build and lifecycle scripts", () => {
  const npmBuildIndex = releaseWorkflow.indexOf("build-npm:");
  const npmPublishIndex = releaseWorkflow.indexOf("publish-npm:");
  const pythonBuildIndex = releaseWorkflow.indexOf("build-python:");
  const npmBuildBlock = releaseWorkflow.slice(npmBuildIndex, npmPublishIndex);
  const npmPublishBlock = releaseWorkflow.slice(npmPublishIndex, pythonBuildIndex);

  assert.doesNotMatch(npmBuildBlock, /id-token: write/);
  assert.doesNotMatch(npmBuildBlock, /environment: npm/);
  assert.match(npmBuildBlock, /uses: actions\/upload-artifact@/);
  assert.match(npmBuildBlock, /sha256sum "\$\{tarballs\[0\]\}"/);
  assert.match(npmBuildBlock, /tarballs=\("\$PWD"\/npm-package\/\*\.tgz\)/);
  assert.match(npmBuildBlock, /test "\$\{#tarballs\[@\]\}" -eq 1/);
  assert.match(npmBuildBlock, /npx -y --package "\$\{tarballs\[0\]\}" headless --help/);
  assert.match(npmPublishBlock, /uses: actions\/download-artifact@/);
  assert.match(npmPublishBlock, /tarballs=\("\$PWD"\/npm-package\/\*\.tgz\)/);
  assert.doesNotMatch(npmPublishBlock, /^\s+npm (?:ci|run check|pack(?:\s|$))/m);
  assert.match(npmPublishBlock, /metadata\.name !== "@roberttlange\/headless"/);
  assert.match(npmPublishBlock, /metadata\.version !== process\.env\.EXPECTED_VERSION/);
  assert.match(
    npmPublishBlock,
    /metadata\.publishConfig\?\.registry !== "https:\/\/registry\.npmjs\.org\/"/,
  );
  assert.match(npmPublishBlock, /EXPECTED_SHA256: \$\{\{ needs\.build-npm\.outputs\.sha256 \}\}/);
});

test("registry mutations fail if the released tag moves", () => {
  const npmPublishIndex = releaseWorkflow.indexOf(
    'npm publish "$TARBALL_PATH" --registry https://registry.npmjs.org/',
  );
  const pypiPublishIndex = releaseWorkflow.indexOf(
    "uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33",
  );
  const tagChecks = [...releaseWorkflow.matchAll(/git ls-remote --tags/g)].map(
    (match) => match.index,
  );

  assert.equal(tagChecks.length, 3);
  assert.ok((tagChecks[0] ?? Infinity) < npmPublishIndex);
  assert.ok((tagChecks[1] ?? -1) > npmPublishIndex);
  assert.ok((tagChecks[1] ?? Infinity) < pypiPublishIndex);
  const recoveryPublishIndex = releaseWorkflow.lastIndexOf(
    "uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33",
  );
  assert.ok((tagChecks[2] ?? -1) > pypiPublishIndex);
  assert.ok((tagChecks[2] ?? Infinity) < recoveryPublishIndex);
  assert.equal(releaseWorkflow.match(/Release tag moved after validation/g)?.length, 2);
  assert.equal(releaseWorkflow.match(/Release tag moved after recovery validation/g)?.length, 1);
});
