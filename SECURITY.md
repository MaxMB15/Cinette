# Security policy

## Supported versions

Only the [latest release](https://github.com/MaxMB15/Cinette/releases/latest)
gets security fixes. The app updates itself, so fixes ship as a new release.

## Reporting a vulnerability

Don't open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/MaxMB15/Cinette/security/advisories/new)
(Security tab → **Report a vulnerability**).

Include what an attacker could do, the steps to reproduce it, and the app version and
OS you found it on. The discussion stays in the private advisory until a fix is
released. Then the advisory is published, with credit to you if you want it.

## Scope

In scope:

- The desktop app and its installers
- The update process: `latest.json`, update signatures and the Linux package
  installer
- Exposure of stored data, such as provider logins or API keys, to other apps or
  websites
- Code execution through a playlist, EPG file or stream

Out of scope:

- Problems in the IPTV providers or services the app connects to
- Vulnerabilities in mpv or FFmpeg themselves. Report those to their projects. If the
  app ships an affected version, tell us so we can update it.
