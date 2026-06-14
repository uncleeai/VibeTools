# VibeTools

A reusable **asset library** for Adobe Premiere Pro 2024+, packaged as a CEP
panel. Save timeline selections (or import external media) as reusable assets,
then drag them back onto the timeline with correct track targeting — every
effect, keyframe, transition and nested structure preserved.

> Windows only. Built and tested on Premiere Pro 2024+ (`PPRO 24.0`+).

VibeTools is free and open source (MIT). If it saves you time, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/uncleluki) ☕ — entirely optional.

---

## What it does

- **Save** a timeline selection as a self-contained asset — it captures a real
  `.prproj` fragment plus an auto-generated preview, so fidelity is exact (not a
  flattened render).
- **Import** external media files as assets.
- **Drag & drop** assets back onto the timeline, dropped on the track you target.
- **Audio assets**: live pitch/reverse preview, rendered with FFmpeg.
- **MOGRT** support.

## Requirements

- Windows
- Adobe Premiere Pro 2024 or newer (24.0+)
- An `ffmpeg.exe` at `vendor/ffmpeg/ffmpeg.exe` (a build is bundled — see
  [FFmpeg](#ffmpeg) below)

## Install (prebuilt)

The repo ships with the prebuilt native binaries, so you don't need Visual
Studio just to run the panel.

1. **Enable unsigned CEP extensions.** VibeTools is not Adobe-signed, so set
   Premiere to allow debug extensions. In the registry under
   `HKEY_CURRENT_USER\Software\Adobe\CSXS.11`, add/set a **String** value
   `PlayerDebugMode = 1`. (The number after `CSXS` matches your CEP runtime; on
   Premiere 2024 it's `CSXS.11`. Restart Premiere afterwards.)

2. **Install the panel.** Copy this whole folder into the CEP extensions
   directory so it lands as:
   ```
   C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\VibeTools\
   ```

3. **Install the importer plugin.** Copy `support_files\VT_Importer.prm` to:
   ```
   C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\VibeTools\
   ```
   (create the `VibeTools` folder). This registers the `.vtbk` extension used
   for precise drag-and-drop track targeting.

4. **Launch.** Start Premiere Pro and open the panel from
   **Window → Extensions → VibeTools**.

### FFmpeg

Audio pitch/reverse previews are rendered by FFmpeg, invoked as a separate
process. A prebuilt `ffmpeg.exe` is bundled at `vendor/ffmpeg/ffmpeg.exe`. If
you remove it or want a different build, drop any `ffmpeg.exe` at that path, or
fetch one via `npm i ffmpeg-static`. See [`vendor/ffmpeg/LICENSE.txt`](vendor/ffmpeg/LICENSE.txt).

## Build from source (optional)

Only needed if you change the native code. Requires Visual Studio 2022 (C++
desktop workload), CMake, x64. Run each batch script **from its own directory**.

| Component | How | Output |
|-----------|-----|--------|
| `VT_ExternalObject.dll` | `cpp\build.bat` | copied to `support_files\` |
| `VT_Importer.prm` | `importer\build.bat` | install to MediaCore (see above) |
| `VT_ControlSurface.acsrf` | build `native\VT_ControlSurface\VT_ControlSurface.sln` | — |

The importer and control surface build against the **Adobe Premiere Pro C++
SDK**, which is proprietary and **not** included here — download it from Adobe
and place it where the build scripts expect (see `CLAUDE.md`).

The web layer (HTML/CSS/JS) is loaded directly by Premiere — no build step.

## Architecture

VibeTools spans four layers across three runtimes (CEP panel → ExtendScript host
→ native DLL → native plugins). The full architecture, data flow, and the
save/apply workflows are documented in [`CLAUDE.md`](CLAUDE.md).

## Contributing

This is a hobby project that isn't actively polished, but issues and PRs are
welcome. There's no automated test suite — changes are verified manually in
Premiere.

## License

[MIT](LICENSE) © 2026 UncleLuki.

Bundled third-party components keep their own licenses — see [CREDITS.md](CREDITS.md).
Notably, the bundled FFmpeg binary is GPLv3; VibeTools calls it as a separate
process and is not a derivative work of it.

Adobe, Premiere Pro, and related marks are trademarks of Adobe Inc. This is an
independent project, not affiliated with or endorsed by Adobe.
