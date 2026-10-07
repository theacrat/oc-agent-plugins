# Publishing

Releases publish `oc-agent-plugins` through `.github/workflows/publish.yml` using npm trusted publishing. No npm publishing token is stored in GitHub. OIDC grants short-lived credentials only to the authorised workflow's publish job; provenance records the source repository and build.

## One-time account setup

1. npm trusted publishers are configured on an existing package. If the package does not exist yet, an npm maintainer must bootstrap `0.1.0` through an interactive `npm login` and `npm publish --access public`, using account 2FA. Do not put that credential in GitHub secrets.
2. In npm package settings, add a GitHub Actions trusted publisher:
   - Owner `theacrat`.
   - Repository `oc-agent-plugins`.
   - Workflow filename `publish.yml`.
   - Environment `npm`.
   - Allow direct `npm publish`.
3. Select “Require two-factor authentication and disallow tokens” in npm publishing access. Trusted publishing remains available.
4. The GitHub `npm` environment should allow release tags only and require maintainer approval before publication. Protect `main` and `v*` tags through repository rulesets.

A new trusted publisher must complete a publication within npm's validation window (currently two days). Configure it shortly before the next release.

## Release

Update `package.json` and `bun.lock`, pass CI on `main`, then create a GitHub release with a tag matching the package version, such as `v0.1.1`. The release must target `main` and must not be marked as a prerelease.

The verify job checks tag/version consistency and main ancestry, runs the full test suite with the pinned Cloudflare fixture, packs the package, and imports that tarball in a production-only installation. Only then may the environment-approved publish job publish the exact verified artifact. Dependency installation and testing run without permission to mint an OIDC credential.

There is no compilation step because OpenCode loads the shipped TypeScript entrypoint. Pull requests never trigger npm publication. Actions are pinned to commit SHAs, cache is disabled in the publishing job, and checkout does not persist Git credentials.
