# Contributing

Thanks for helping with Cinette. Bug reports, feature ideas and pull requests are all
welcome.

## Reporting a bug

[Open a bug report](https://github.com/MaxMB15/Cinette/issues/new?template=bug_report.yml)
and include:

- Your OS and version, and on Linux your desktop and whether it's Wayland or X11
- The app version (Settings shows it) and how you installed it
- Steps that reproduce the problem

Playlist URLs and Xtream Codes links contain your username and password. Remove them
from anything you paste, including logs.

If a stream won't play, check first whether it plays in [mpv](https://mpv.io) or VLC.
If it doesn't play there either, the problem is most likely the stream itself.

Security problems go through private reporting instead. See [SECURITY.md](SECURITY.md).

## Suggesting a feature

[Open a feature request](https://github.com/MaxMB15/Cinette/issues/new?template=feature_request.yml).
Describe the problem you want solved before the solution you have in mind. That
leaves room for other ways to solve it.

## Pull requests

For anything bigger than a small fix, open an issue first so we can agree on the
approach before you put time into it.

1. Set up the app from source with [docs/development.md](docs/development.md).
   [docs/architecture.md](docs/architecture.md) explains how the code fits together.
2. Branch from `dev`, and open the pull request against `dev`. CI fails pull requests
   into `main` from any other branch, because `main` only changes when a release is
   cut.
3. Keep each pull request to one change. Refactors and formatting changes go in their
   own pull request.
4. Add or update tests for what you changed. Rust tests sit in a `tests` module at
   the bottom of the file they test, and frontend tests use Vitest.
5. Run the checks before pushing. The pre-commit hook formats and lints the files
   you staged, then runs the tests. CI also fails on any Clippy warning, and when
   Rust line coverage drops below 80%.

   ```bash
   pnpm format
   pnpm lint
   pnpm test
   cargo clippy --workspace --all-targets -- -D warnings
   ```

6. If you changed playback or anything platform-specific, say in the pull request
   which OS you tested on.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org): a type, an optional
scope, and a short summary in the imperative.

```
fix(linux): keep the video surface below the webview after resizing
feat(player): add a playback speed control
docs: explain how to build libmpv on Fedora
```

Common types are `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci` and `chore`.

### Code style

- TypeScript and React use arrow functions, never `function` declarations.
  `export default function` is the one exception.
- Every call into the Rust backend goes through `apps/player/src/lib/tauri.ts`.
- Prettier and ESLint settle formatting. Don't fight them.

## License and contributor agreement

Cinette is licensed under the [GNU General Public License version 3](LICENSE),
with the additional terms in [NOTICE](NOTICE).

Before your first pull request can be merged, you need to accept the
[Contributor License Agreement](CLA.md). You keep the copyright in your work. The
agreement lets the project's owner also offer Cinette under other licenses,
such as a commercial license or a build for an app store that doesn't accept GPL
software. You accept it by checking the box in the pull request template.

If your pull request includes code you didn't write, say where it comes from and
what license it has.
