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
3. Bumps the version in `tauri.conf.json` and `Cargo.toml` with
   [`scripts/bump-version.py`](../scripts/bump-version.py) and commits it.
4. Pushes the `vX.Y.Z` tag, which starts `release.yml`.

The run's summary links to the release run. Open it and approve the macOS job
(**Review deployments**, tick `macos-signing`, **Approve and deploy**) so it can sign
and notarize the app. When the release run finishes, publish the draft (see
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
2. Builds macOS and Linux in parallel and uploads them to the draft. The macOS job
   waits until you approve it in Actions, then signs and notarizes the app when the
   Apple secrets are set (see [macos-signing.md](macos-signing.md)).
3. Writes `latest.json`, the file the in-app updater reads, and uploads it.
4. Merges `main` back into `dev` so the version bump reaches `dev`.

The installers have no version in their names, so the README links to
`releases/latest/download/<name>` always get the newest build. A release has nine
assets:

| Asset | What it is |
| --- | --- |
| `MaxVideoPlayer_aarch64.dmg` | macOS installer |
| `MaxVideoPlayer_amd64.AppImage` | Linux AppImage |
| `MaxVideoPlayer_amd64.deb` | Debian and Ubuntu package |
| `MaxVideoPlayer_x86_64.rpm` | Fedora package |
| `MaxVideoPlayer_<version>_aarch64.app.tar.gz` | macOS update for the in-app updater |
| `MaxVideoPlayer_linux.tar.gz` | AppImage update for the in-app updater |
| `MaxVideoPlayer_<version>_aarch64.app.tar.gz.sig`, `MaxVideoPlayer_linux.tar.gz.sig` | Signatures for the two updates |
| `latest.json` | Update manifest: version, signatures and download links |

Don't rename these. The README, `latest.json` and the Linux package updater in
`commands.rs` all depend on the names.

The iPhone and iPad app isn't part of this. It goes to TestFlight through its own
manual workflow, described in [ios.md](ios.md#continuous-integration).

## Publishing

1. Open the draft on the [releases page](https://github.com/MaxMB15/MaxVideoPlayer/releases).
2. Check that all nine assets are there.
3. Replace the notes with the version's section from the changelog.
4. Publish.

Publishing makes it the latest release, so the README links and the in-app updater
switch to it right away. Then check that the README download links and every link in
`latest.json` work:

```bash
./scripts/validate-release.sh            # the latest release
./scripts/validate-release.sh v0.6.0     # a specific tag
```

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
cd apps/desktop && npx tauri signer generate -w ~/.tauri/maxvideoplayer.key
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
