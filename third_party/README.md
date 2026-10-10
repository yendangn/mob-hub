# Third-party software

The packaged app (`.dmg`) contains this third-party software. Its license is not the license of this project.

| Component | Version | License | Source |
|---|---|---|---|
| scrcpy-server | 5.0.1 | Apache-2.0, see [scrcpy/LICENSE](scrcpy/LICENSE) | https://github.com/Genymobile/scrcpy |

The binary is not in this repository. `scripts/fetch-server.mjs` downloads the unmodified file from the official scrcpy GitHub release.

The npm dependencies that the app bundles use the MIT license. Their license texts are in `node_modules/<package>/LICENSE`.
