# macOS code signing and notarization

Release builds of the macOS app can be signed with a Developer ID certificate and
notarized by Apple. A signed and notarized DMG opens with a normal double-click on
any Mac. An unsigned one makes Gatekeeper refuse to open it until the user allows it
in System Settings.

Signing is optional. Without the secrets below, CI builds the app exactly as before,
unsigned, and nothing fails.

## What CI does

When the secrets are set, the macOS release job:

1. Imports the certificate into a temporary keychain
   ([`.github/actions/macos-signing`](../.github/actions/macos-signing/action.yml)).
2. Signs the bundled libraries in `Contents/Frameworks` with the hardened runtime and
   a secure timestamp ([`scripts/bundle-libmpv.sh`](../scripts/bundle-libmpv.sh)).
   Tauri doesn't sign files it copies into the bundle, and a hardened app only loads
   libraries signed by the same team.
3. Lets `tauri build` sign the ffmpeg sidecar, the main binary and the app, then
   notarize the app and staple the ticket to it
   ([`scripts/build-app.sh`](../scripts/build-app.sh)). The DMG step fails now and
   then on the hosted runners, so a failed build runs once more, and the app is
   signed and notarized again.
4. Notarizes the DMG and staples it ([`scripts/notarize-macos.sh`](../scripts/notarize-macos.sh)).
   Stapling downloads the ticket from Apple, so the script tries up to five times
   if the connection drops.
5. Checks that every binary in the app is signed by the same team with a timestamp,
   that executables use the hardened runtime, and that Gatekeeper accepts the app and
   the DMG ([`scripts/verify-macos-signing.sh`](../scripts/verify-macos-signing.sh)).

The secrets live in the `macos-signing` environment, which needs a reviewer's
approval and only accepts `main`, `dev` and `v*` tags. Each release and each manual
Build & Bundle run waits in Actions until a reviewer approves it. Push and pull
request builds don't use the environment, so they never wait and are never signed.

Apple's signature is separate from the updater signature (`TAURI_SIGNING_PRIVATE_KEY`).
The updater still needs its own key.

## One-time setup

You need a paid Apple Developer Program membership. On an organization account,
only the Account Holder can create a Developer ID certificate.

### 1. Create a Developer ID Application certificate

The simplest way is Xcode, which creates the private key in your login keychain:

1. Xcode → Settings → Accounts → select your team → Manage Certificates.
2. Click **+** → **Developer ID Application**.

Without Xcode:

1. Keychain Access → Certificate Assistant → Request a Certificate From a Certificate
   Authority. Enter your email, choose **Saved to disk**.
2. On [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates/list),
   click **+**, choose **Developer ID Application** (G2 Sub-CA), and upload the request.
3. Download the certificate and double-click it to add it to your login keychain.

It must be **Developer ID Application**. Apple Development and Mac App Distribution
certificates can't sign apps distributed outside the App Store, and CI rejects them.

### 2. Export it as a .p12

1. Keychain Access → login keychain → **My Certificates**.
2. Right-click **Developer ID Application: Your Name (TEAMID)** → Export. Make sure
   the entry has a disclosure arrow with the private key under it.
3. Save as `.p12` and set a password.

### 3. Create an App Store Connect API key for notarization

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
   The first time, the Account Holder has to request access.
2. Under **Team Keys**, click **+**. Name it (for example "MaxVideoPlayer CI") and give
   it the **Developer** role.
3. Download the `AuthKey_<KEY ID>.p8` file. Apple lets you download it only once.
4. Note the **Key ID** (in the table) and the **Issuer ID** (above the table).

Use a Team Key. Individual Keys have no Issuer ID, and `notarytool` needs one.

### 4. Add the secrets to the `macos-signing` environment

GitHub → the repository → Settings → Environments → `macos-signing`. If it isn't
there, click **New environment** and name it `macos-signing`. Then:

1. Under **Deployment protection rules**, tick **Required reviewers**, add yourself,
   and click **Save protection rules**. Leave **Prevent self-review** off, or you
   can't approve your own releases.
2. Under **Deployment branches and tags**, choose **Selected branches and tags**. Add
   the branches `main` and `dev` and the tag pattern `v*`. An approved job runs the
   build scripts from its own branch with the Apple secrets, so only refs you trust
   may use them.
3. Under **Environment secrets**, click **Add environment secret** for each of these:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | The `.p12` file, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_API_KEY_ID` | The API key's Key ID |
| `APPLE_API_ISSUER` | The Issuer ID |
| `APPLE_API_PRIVATE_KEY` | The full contents of the `.p8` file, including the `BEGIN` and `END` lines |

With the GitHub CLI, values go straight from the files to GitHub without passing
through the clipboard:

```bash
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --env macos-signing
gh secret set APPLE_CERTIFICATE_PASSWORD --env macos-signing    # prompts for the value
gh secret set APPLE_API_KEY_ID --env macos-signing --body "ABC123DEFG"
gh secret set APPLE_API_ISSUER --env macos-signing --body "00000000-0000-0000-0000-000000000000"
gh secret set APPLE_API_PRIVATE_KEY --env macos-signing < AuthKey_ABC123DEFG.p8
```

Don't add them as repository secrets. Any workflow could read those without
approval.

With only the two certificate secrets set, builds are signed but not notarized. Set
either none or all three API key secrets; a partial set fails the build. So do API
key secrets without the certificate, since Apple only notarizes signed apps.

Delete the `.p12` and `.p8` files afterwards, or keep them in a password manager.

### 5. Test it without releasing

Run the **Build & Bundle** workflow by hand. A manual run builds only macOS, and it
signs, notarizes and verifies the app the same way a release does. Push and pull
request builds stay unsigned so they don't wait on Apple.

```bash
gh workflow run build.yml --ref dev    # or main
```

The macOS job then waits for approval. Open the run in Actions and check that it's on
the branch and commit you expect, then click **Review deployments**, tick
`macos-signing` and click **Approve and deploy**. Releases wait the same way. A manual
run on any other branch fails, because the environment doesn't accept it.

Once this change reaches `main`, you can also use Actions → **Build & Bundle** →
**Run workflow**. GitHub only shows that button for workflows that accept manual runs
on the default branch.

Download the `MaxVideoPlayer-macOS` artifact, open the DMG on a Mac and drag the app to
Applications. It should open without a Gatekeeper warning. Test with the DMG rather
than the `.app` in the artifact, because artifact downloads lose file permissions.

Notarization usually takes a few minutes per submission, and each build submits
twice (the app, then the DMG).

## Troubleshooting

| Error | Cause |
| --- | --- |
| `APPLE_CERTIFICATE has no Developer ID Application certificate` | The `.p12` holds a different kind of certificate, or only the certificate without its private key. Export again from **My Certificates**. |
| `security: SecKeychainItemImport: MAC verification failed` | `APPLE_CERTIFICATE_PASSWORD` doesn't match the `.p12`. |
| Notarization status `Invalid` | The job prints Apple's log, which names each rejected file and the reason. |
| `... is signed by team 'none'` or `has no secure timestamp` | A binary in the app wasn't signed by CI. Sign it in `bundle-libmpv.sh` alongside the libraries. |
| `HTTP status code: 401` from `notarytool` | Wrong Key ID or Issuer ID, a revoked key, or an Individual Key. |

## Renewing the certificate

Developer ID certificates are valid for five years. Create a new one, export it, and
replace `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` in the `macos-signing`
environment. Apps signed with the
old certificate keep working after it expires, because their signatures carry a
timestamp.

## Signing a local build

With the certificate in your login keychain:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
# Optional, to notarize as well:
export APPLE_API_KEY=ABC123DEFG APPLE_API_ISSUER=... APPLE_API_KEY_PATH=~/keys/AuthKey_ABC123DEFG.p8
cd apps/desktop && npx tauri build
```
