# Branching and release workflow

OpenLabel uses a small trunk-based workflow with short-lived feature branches.

## Branches

| Branch | Purpose | Lifetime |
| --- | --- | --- |
| `main` | Always releasable; protected, CI required | permanent |
| `feat/<scope>` | One feature or refactor | days |
| `fix/<scope>` | One bug fix | days |
| `docs/<scope>` | Documentation only | days |
| `release/<version>` | Optional release hardening | until tag |

Squash merges are preferred for small branches; `--no-ff` merges are used when
the individual commits document a design decision worth preserving. Feature
branches are deleted after merge.

## Commit convention

Conventional Commits: `type(scope): summary`, imperative, lower case, no
trailing period. Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`,
`build`, `ci`, `chore`.

Examples:

```text
feat(autolabel): train softmax from window descriptors
fix(studio): keep zoom anchored when switching images
docs(datasets): document YOLO-seg export layout
```

## Required checks

`npm run verify` locally, and on GitHub: lint → unit tests → build → Playwright
(Chromium).

## Release

1. Update `package.json` version and `docs/ROADMAP.md` if needed.
2. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
3. The `Publish npm package` workflow builds `packages/cli/dist`, stamps the CLI
   version from the tag, and publishes `openlabel` to npm with provenance. It
   needs an `NPM_TOKEN` repository secret — an npm token with publish rights for
   the `openlabel` package.
4. GitHub release notes are generated from commits since the previous tag.

To publish by hand, log in first, then build and publish from the CLI package:

```bash
npm login                                   # once per machine
npm run build:npm
cd packages/cli && npm publish --access public --no-provenance
```

Local publishes cannot attach provenance, so pass `--no-provenance`; the tag
workflow generates it because it runs on GitHub Actions.