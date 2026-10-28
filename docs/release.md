# Release Checklist

This repo publishes two artifacts for each release:

- npm package: `@stephenzhou01/pi-web`
- GitHub Release: `sdivens/pi-web`

Use this checklist from a clean `main` checkout.

## 1. Preflight

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate -5
git rev-list --left-right --count main...origin/main
gh auth status
npm whoami
node -e "const p=require('./package.json'); console.log(p.version)"
lsof -nP -iTCP:30141 -sTCP:LISTEN
ls .next/server/route-cache
```

Expected:

- `git status` is clean, or only contains changes you intentionally plan to release.
- `main` and `origin/main` are aligned (`0	0`).
- GitHub is authenticated as an account that can push and create releases.
- npm is authenticated as an account that can publish `@stephenzhou01/pi-web`.
- No dev server is serving **this checkout**: the production build wipes `.next/`, which breaks a running `npm run dev`. A globally installed `pi-web` in another directory is fine and keeps running.
- `.next/server/route-cache/` does not exist. An e2e run in `start` mode writes it (`next start` does, the build does not), and it would be published. `npm run release` wipes `.next` before building, so the script takes care of it.

Before bumping, confirm the next version is free (replace `<version>`):

```bash
npm view @stephenzhou01/pi-web@<version> version --registry https://registry.npmjs.org/   # expect E404
git ls-remote --tags origin v<version>                                            # expect empty
```

## 2. Publish with one command

```bash
npm run release              # bump decided from the commits since the last tag
npm run release -- --minor   # force the bump: --patch / --minor / --major
```

`scripts/release.mjs` runs the whole checklist and stops at the first problem with the reason and the fix, **before it writes anything**:

1. **preflight** — repo root, branch (`main` unless `--any-branch`), clean tree, no dev server serving this checkout (a stale `.next/dev/lock` whose holder is gone is ignored), registry is npmjs, `npm whoami`, `private` is not set, `files` ships `.next`, the next version is free on npm, and the tag is free locally and on `origin`.
2. **checks** — `npm run lint`, `npx tsc --noEmit`, `npm test`. `--skip-checks` skips all three, `--skip-tests` only the tests, `--e2e` adds the e2e suite.
3. **release** — bump `package.json` + `package-lock.json`, commit `Release v<version>`, annotated tag `v<version>`.
4. **build** — wipes `.next` first (a `next start`/e2e run leaves `.next/server/route-cache` behind, the build keeps it and the package would ship it), then `npm run build`, then refuses `.next/dev` or `.next/server/route-cache`.
5. **tarball** — `npm pack --dry-run` must hold `package.json`, `bin/pi-web.js`, `.next/BUILD_ID`, and nothing from `.next/dev`, `.next/cache`, `.next/server/route-cache`, no source maps, no env files, no `demo/`, `e2e/` or `docs/`.
6. **publish** — `npm publish --access public`. With 2FA the terminal asks for the one-time code; answer it there.
7. **verify** — poll the registry until the version returns 200, require `dist-tags.latest` to point at it, then install the published tarball into a temporary prefix and run `pi-web version`.

Two rehearsals: `--dry-run` prints the version it would release and touches nothing; `--no-publish` does everything up to the tarball check and stops.

A failure after step 3 leaves the release commit and tag in place. The script prints what undoes them (`git reset --hard <previous head>`, `git tag -d v<version>`) and never rolls back on its own. Nothing reaches npm unless step 6 succeeds, so undoing never needs `npm unpublish`.

Known blocker: `npm test` is red on `main` for `lib/enabled-models-runtime.test.mjs` ("a bare id shared by two providers matches both"), so a release stops there. Fix that test, or release with `--skip-tests`.

The commands the script runs (useful when debugging it, not a second way to release):

```bash
npm version <version> --no-git-tag-version
git add package.json package-lock.json && git commit -m "Release v<version>"
git tag -a v<version> -m "v<version>"
npm run build
npm publish --access public
```

Choosing the bump: a batch of `feat:` commits (new UI, new commands, new settings) is a minor, only fixes and small adjustments a patch, a `!:`/`BREAKING CHANGE:` commit a major. The script reads this from `git log --oneline v<previous>..HEAD`; pass the flag to override. A published version cannot be reused.

Notes:

- This bumps `package.json` and `package-lock.json`.
- The first publish of a brand-new package name goes to npm's review instead of straight to the registry: `npm publish` prints `+ <name>@<version>`, the package page shows a `0.0.0-stage` "Temporary Holding Version", and `npm view <name>@<version>` keeps returning E404 until the review clears (minutes to a few hours). `npm stage list <name>` is empty in that case, because the hold is npm's, not a staged publish of yours. Do not publish the same version again; poll the registry. Later versions of an approved package publish immediately.
- It intentionally runs a production build. Do not run `next build` during normal development; release work is the exception.
- A newly published version may take a few minutes to show up. The script waits up to five minutes, then tells you to look again rather than publishing twice.

## 3. Push the commit and tag

The script commits the bump and creates the tag; it never pushes.

```bash
git push origin main v<version>
```

Push the release tag by name. Do not use `git push --tags`: the local checkout holds tags fetched from contributor forks that are not on origin, and `--tags` publishes them (it leaked a stray `v0.10.5`, on a commit that is on no branch, during the v0.11.0 release). If you ever need `--tags`, compare `git tag` with `git ls-remote --tags origin` first.

## 4. Generate Release Notes from Commits

Use the previous release tag as the base.

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Write the release notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes or PR numbers next to each item when useful.

- Check commands, flags and setting names against `README.md` and the code before writing them down.
- Thank outside contributors by name: `git log --format='%h %an | %s' v<previous>..v<version>` lists authors, and the previous release's notes show the style.
- Open with the install/upgrade command (`npm install -g @stephenzhou01/pi-web@latest`), as earlier releases did.
- Write the notes to a file outside the repo (for example `NOTES=$(mktemp)`), or pass them through stdin as shown below. A `release-notes.md` in the repo root is an untracked file in the next release's `git status`.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 npm 包 `@stephenzhou01/pi-web@<version>`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published npm package `@stephenzhou01/pi-web@<version>`.
```

## 5. Create or Update the GitHub Release

Create a new release:

```bash
gh release create v<version> \
  --repo sdivens/pi-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file "$NOTES"
```

If the release already exists and only the notes need updating:

```bash
gh release edit v<version> \
  --repo sdivens/pi-web \
  --notes-file "$NOTES"
```

You can avoid a temporary file by passing notes through stdin:

```bash
gh release edit v<version> --repo sdivens/pi-web --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 6. Final Verification

```bash
gh release view v<version> --repo sdivens/pi-web
npm view @stephenzhou01/pi-web@<version> version --registry https://registry.npmjs.org/
npm view @stephenzhou01/pi-web dist-tags --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
git ls-remote --tags origin
```

Expected:

- GitHub Release exists and is not a draft unless intentionally published as one.
- npm exact version resolves and `latest` points at it (allow a few minutes, see step 2).
- `git ls-remote --tags origin` shows no tag you did not mean to publish.
- `main` is aligned with `origin/main`.
- `HEAD` points at the release commit and `v<version>` tag.
