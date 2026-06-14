# Credits & third-party notices

VibeTools is licensed under the [MIT License](LICENSE). It bundles and relies on
the following third-party components, each under its own license:

## FFmpeg
- Used to render audio pitch/reverse previews. VibeTools invokes it as a
  **separate process** — it is not linked into VibeTools' code.
- Bundled binary: FFmpeg 6.1.1 "essentials" build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/),
  configured with `--enable-gpl --enable-version3` → **GPLv3**.
- License and corresponding-source details: [`vendor/ffmpeg/LICENSE.txt`](vendor/ffmpeg/LICENSE.txt).
- FFmpeg website: https://ffmpeg.org

## Adobe CEP / Premiere Pro SDK
- VibeTools is a CEP panel for Adobe Premiere Pro and uses Adobe's
  `CSInterface.js` bridge ([`lib/CSInterface.js`](lib/CSInterface.js)) and CEP APIs.
- The native plugins (`VT_Importer.prm`, `VT_ControlSurface.acsrf`) build against
  the **Adobe Premiere Pro C++ SDK**, which is proprietary to Adobe and **not**
  included in this repository — download it from Adobe to build them yourself.
- Adobe, Premiere Pro, and related marks are trademarks of Adobe Inc. VibeTools
  is an independent project, not affiliated with or endorsed by Adobe.

## Jungle (Web Audio pitch shifter)
- [`js/jungle.js`](js/jungle.js) — Copyright 2012 Google Inc., **BSD 3-Clause**
  license (full text in the file header). Used for the live audio-preview pitch
  feature.
