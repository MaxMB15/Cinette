# Releasing

A release is a `vX.Y.Z` tag on `main`. Pushing the tag runs
[`release.yml`](../.github/workflows/release.yml), which builds both platforms and
uploads everything to a draft GitHub release. Users get nothing until you publish
the draft.

## Before you start

1. Merge everything for the release into `dev`. The one-click pipeline checks that
   `dev`'s build passed. The other ways don't, so check Actions first if you use them.
2. Add the release to [CHANGELOG.md](../CHANGELOG.md) on `dev`: rename the
   `Unreleased` section to the new version and date, and start a new empty
   `Unreleased` section above it.

## Cutting a release

### One-click pipeline (usual way)

Actions → **Release — one-click pipeline** → **Run workflow**, then pick `patch`,
`minor` or `major`.

The workflow:

1. Waits for **Build & Bundle** on `dev` to finish, and stops if it failed. Merges
   that only change docs or Markdown don't start a build, so it checks the build
   that covers the newest code change. It gives up after an hour.
2. Merges that `dev` commit into `main`. Anything pushed to `dev` while it waits
   stays out of the release.
3. Bumps the version in `tauri.conf.json`, `Cargo.toml` and the iOS project's
   `project.yml` and `Info.plist` with
   [`scripts/bump-version.py`](../scripts/bump-version.py) and commits it.
4. Pushes the `vX.Y.Z` tag, which starts `release.yml`.

The run's summary links to the release run. Open it and approve the macOS jobs
(**Review deployments**, tick `macos-signing`, **Approve and deploy**) so they can
sign and notarize the app. The Apple Silicon and Intel builds both wait on
`macos-signing`. If one of them is still waiting after you approve, approve it the
same way. When the release run finishes, publish the draft (see
[Publishing](#publishing)).

Tick **Dry run** to check the build and see the merge and the new version without
pushing anything.

### Two-step fallback

If `main` is protected so that only pull requests can change it:

1. Open a pull request from `dev` to `main` and merge it. The next step only bumps
   the version, so skipping this one releases the old code.
2. Actions → **Release — bump version (PR)** opens a pull request that bumps the
   version on `main`. Merge it once checks pass. Squash merge if `main` requires
   signed commits.
3. Actions → **Release — push tag** tags `main` with the version from
   `tauri.conf.json`.

### From your machine

On an up-to-date `main`, `./scripts/release.sh` bumps the version, commits and tags.
If the version is already bumped on `main`, tag it yourself:

```bash
git tag v0.6.0 && git push origin v0.6.0
```

## What the release workflow does

1. Creates the draft release `vX.Y.Z`.
2. Builds macOS and Linux in parallel and uploads them to the draft. macOS gets
   two builds, one on an Apple Silicon runner and one on an Intel runner. Both wait
   until you approve them in Actions, then sign and notarize the app when the Apple
   secrets are set (see [macos-signing.md](macos-signing.md)).
3. Writes `latest.json`, the file the in-app updater reads, and uploads it.
4. Merges `main` back into `dev` so the version bump reaches `dev`.

The installers have no version in their names, so the README links to
`releases/latest/download/<name>` always get the newest build. A release has twelve
assets:

| Asset | What it is |
| --- | --- |
| `Cinette_aarch64.dmg` | macOS installer for Apple Silicon |
| `Cinette_x64.dmg` | macOS installer for Intel |
| `Cinette_amd64.AppImage` | Linux AppImage |
| `Cinette_amd64.deb` | Debian and Ubuntu package |
| `Cinette_x86_64.rpm` | Fedora package |
| `Cinette_<version>_aarch64.app.tar.gz` | Apple Silicon update for the in-app updater |
| `Cinette_<version>_x64.app.tar.gz` | Intel update for the in-app updater |
| `Cinette_linux.tar.gz` | AppImage update for the in-app updater |
| `Cinette_<version>_aarch64.app.tar.gz.sig`, `Cinette_<version>_x64.app.tar.gz.sig`, `Cinette_linux.tar.gz.sig` | Signatures for the three updates |
| `latest.json` | Update manifest: version, signatures and download links |

Don't rename these again. Every installed copy fetches `latest.json` by that name
to find updates, so renaming it would cut them all off. The README and the website
link to the installers by name, and so do links on other sites.

Releases from before the app became Cinette name these files `MaxVideoPlayer_*`
instead. The website takes either name, so it still works while the newest release
has the old ones.

The repo was called `MaxMB15/MaxVideoPlayer` until October 2026. GitHub sends
the old repo URLs to the new name, though not the old GitHub Pages ones. Copies
from 0.7.0 and earlier find updates through that redirect, since `latest.json`'s
address is built into them. Never create a repo with the old name under this
account, because GitHub then stops redirecting and those copies stop getting
updates.

The `.deb` and `.rpm` packages are called `cinette`, which the bundler makes from
`productName`. Releases before the rename made a package called
`max-video-player`. In `tauri.conf.json`, the `.deb` conflicts with and replaces
that package and the `.rpm` obsoletes it, so installing or updating removes the old
package. Keep those fields.

The iPhone and iPad app isn't part of this. It goes to TestFlight through its own
manual workflow, described in [ios.md](ios.md#continuous-integration).

## Publishing

1. Open the draft on the [releases page](https://github.com/MaxMB15/Cinette/releases).
2. Check that all twelve assets are there.
3. Replace the notes with the version's section from the changelog.
4. Publish.

Publishing makes it the latest release, so the README links and the in-app updater
switch to it right away. When the tag's tree has `.github/workflows/site.yml`,
publishing also starts the Website workflow, which rebuilds the
[website](https://maxmb15.github.io/Cinette/) with the new version, links and
file sizes. A pre-release doesn't start it, and changing a pre-release to a full
release later does. GitHub runs a release's workflows from its tag, and v0.7.0 and
earlier came before that workflow. The site's first deploy comes from the push to
`main` that the next release's merge makes. If that run fails, run **Website** by
hand from `main`.

After publishing:

1. Check that the README download links and every link in `latest.json` work:

   ```bash
   ./scripts/validate-release.sh            # the latest release
   ./scripts/validate-release.sh v0.6.0     # a specific tag
   ```

2. In Actions, check that the **Website** run for the release passed, and re-run it
   if it didn't. Start it by hand from `main` if the release started none. Its
   build asks GitHub's API up to three times, then fails rather than publish a
   page without sizes.

If you replace a release's files later, run **Website** by hand from `main`
(**Run workflow**), so the page shows the new files' sizes and checksums.

## Secrets and settings

All under Settings → Secrets and variables → Actions, except the Apple secrets, which
are in Settings → Environments → `macos-signing`.

| Name | Kind | Used for |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Secret | Signs updates so installed apps accept them. Required. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret | The key's password, if it has one. |
| `RELEASE_AUTOMATION_PAT` | Secret | Fine-grained token with Contents and Pull requests write access. The release workflows push to `main` and open pull requests with it, because `GITHUB_TOKEN` often isn't allowed to. Required. |
| `APPLE_CERTIFICATE` and four others | Environment secrets | Optional macOS signing and notarization, in the `macos-signing` environment. See [macos-signing.md](macos-signing.md). |
| `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION` | Environment secrets | Signing for TestFlight uploads, in the `macos-signing` environment. Optional when the API key has the Admin role. See [ios.md](ios.md#testflight-setup). |
| `RELEASE_ALLOWED_ACTORS` | Variable | Comma-separated GitHub usernames allowed to run the release workflows. Defaults to the repository owner. |

The updater key pair is created once:

```bash
cd apps/player && pnpm tauri signer generate -w ~/.tauri/maxvideoplayer.key
```

The public key goes in `plugins.updater.pubkey` in `tauri.conf.json`. Keep the
private key safe. If it's lost, installed copies can't verify new updates, and
everyone has to download the next version by hand.

## If something goes wrong

- **A build job failed.** Fix it on `dev`, then rerun the failed jobs from the
  workflow run. The draft keeps what was already uploaded, and uploads overwrite
  existing assets.
- **A published release is broken.** Release a fixed patch version. Don't delete
  the release. Installed apps update from whatever release is marked latest.
- **The app crashes before it can update** (as 0.5.0 and 0.5.1 did on macOS). The
  updater can't help, so add a note to the README's FAQ telling people to download
  the new version by hand.
