# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VibeTools is an Adobe CEP extension **panel for Premiere Pro 2024+** (bundle ID `com.vibetools.panel`, host `PPRO [24.0,99.9]`). It is an asset-library manager: the user saves timeline selections or imports media as reusable assets, then drags them back onto the timeline with correct track targeting. The repo lives *inside the installed CEP extensions folder* — editing files here edits the live installed panel.

## Architecture (4 layers, crossing 3 language boundaries)

The hard part of this codebase is that a single user action travels across several runtimes. Understand this flow before changing anything:

1. **CEP panel UI** — `index.html` + `css/styles.css` + `js/main.js` (the bulk of the UI logic, loaded as an ES module). Runs in Chromium with Node.js enabled (`window.require('fs'|'path'|'os'|'child_process')`). `lib/CSInterface.js` is Adobe's bridge; `js/jungle.js` is a pitch-shifter library (a global `Jungle`, loaded via a plain `<script>`) used for live audio-preview pitch. Two ES modules are split out and imported by `main.js`: `js/audioPreview.js` (the `AudioPreview` player plus `generateWaveform` / `setupStaticWaveform` / `loadAudioBuffer`, with its own node requires and `FFMPEG_PATH`) and `js/log.js` (the shared `addLog` debug-panel logger). New web-layer modules are picked up automatically via ES `import` — no `<script>` tag to add in `index.html`.
2. **ExtendScript host** — `jsx/hostscript.jsx` (~2400 lines). Runs in Premiere's ExtendScript engine and is the *only* layer with access to the Premiere DOM (`app.project`, sequences) and QE API. Every function is prefixed `VT_`.
3. **Native command DLL** — `VT_ExternalObject.dll` (built from `cpp/`). Loaded by ExtendScript via `new ExternalObject('lib:...')`. Executes Premiere internal commands (copy/paste/group/selectAll) by delegating to the control-surface plugin, with a Win32 `SendInput` keyboard fallback (`cmd.edit.copy` → Ctrl+C, etc.).
4. **Native plugins** (built separately, require the Premiere Pro SDK):
   - `VT_ControlSurface.acsrf` (from `native/VT_ControlSurface/`) exports `vtApiExecuteCommand`; gives the DLL access to `ControlSurfaceHostCommandSuite` for track-targeted commands.
   - `VT_Importer.prm` (from `importer/`) registers the `.vtbk` file extension and creates placeholder clips, enabling precise track targeting on drag-and-drop.

### Communication flow
`js/main.js` calls ExtendScript via `csInterface.evalScript(...)` — wrapped in `evalScriptAsync()` (a small Promise wrapper near the bottom of `main.js`). ExtendScript `VT_*` functions run, and for command execution call `$.global.VT_ExtObj.doCommand(cmd)` into the DLL, which calls the control-surface plugin.

### Drag-and-drop workflow (the `.vtbk` trick)
On drag start, `main.js` writes a temporary `.vtbk` JSON file to `%TEMP%\VibeTools`. Premiere's importer (`VT_Importer.prm`) turns it into a placeholder clip dropped on the timeline; ExtendScript then locates the placeholder (`VT_findPlaceholder`) and copy/pastes the real asset onto the targeted track via the DLL. Audio and MOGRT assets are special-cased (audio uses a temp copy and ffmpeg for pitch/reverse; MOGRT uses `VT_insertMogrt`).

### Asset storage
Assets live in `%APPDATA%\VibeTools\assets` (`ASSETS_DIR` in `main.js`). A saved asset is a `.prproj` + `.json` metadata + auto-generated `.mp4` preview. Imported external files are flagged `isExternal`. Audio preview (pitch/reverse) is rendered with the bundled `node_modules/ffmpeg-static/ffmpeg.exe`.

### Saving an asset (the core feature — `VT_saveAssetNative`, `hostscript.jsx:1150`)
This is the heart of the tool: it captures a timeline selection as a **self-contained `.prproj`** so every effect, keyframe, transition, and nested structure is preserved exactly, plus a rendered preview. `js/main.js` (in the save-asset handler) shows a blocking overlay and calls `VT_saveAssetNative("<ASSETS_DIR>/asset_<timestamp>.prproj")`. The ExtendScript routine then, in one round-trip:
1. Re-focuses the source sequence (`openSequence` + QE `makeCurrent`) — the click came from the CEP panel, so the timeline must be refocused or the copy command targets nothing.
2. Copies the selection via the native DLL (`cmd.edit.copy`).
3. Imports the bundled `VideoSampleLong.mp4` into a `VibeAssets` bin and uses it as a *seed* for `createNewSequenceFromClips` — this creates a temp sequence (`VT_Asset_<time>`) **without triggering Premiere's New Sequence dialog**. The sample lands on V1.
4. Adds V2, targets V2/A1, and pastes the copied clips above the sample.
5. **Renders a 480p preview** (`<asset>.mp4`) of the temp sequence (sample as backdrop on V1 + clips on V2) via `app.encoder` using the bundled `VT_Preview_480p.epr` preset, with in/out set to the pasted clips' duration.
6. Removes the VideoSample and **normalizes** the user's clips down to V1/A1 (via copy → delete → paste) so the saved project contains only their content.
7. `newSeq.exportAsProject(outputPath)` writes the standalone `.prproj`, then closes the temp sequence, restores the original sequence + playhead, and deletes the temp sequence item using the "create temp bin → `moveBin` → `deleteBin`" workaround (ExtendScript has no direct sequence-delete).
8. Returns JSON; `main.js` writes `<assetId>.json` metadata and re-renders the grid.

Because the asset *is* a real project fragment, applying it later (`VT_applyAssetNative`) imports the `.prproj` and copy/pastes its clips back onto the targeted track — preserving fidelity that a flat media file could not. `VideoSampleLong.mp4` and `VT_Preview_480p.epr` are therefore required at the extension root for saving to work; missing them aborts the save (no-dialog sequence creation fails).

## Build commands

There is **no npm build / lint / test tooling** (the only `package.json` just pulls in `ffmpeg-static`). The web layer (HTML/CSS/JS) is loaded directly by Premiere — no bundling step.

Native code is built with batch scripts that must be run **from their own directory** (require Visual Studio 2022 with the C++ desktop workload, CMake, x64):

- `cpp\build.bat` — builds `VT_ExternalObject.dll`, copies it to `support_files\`.
- `importer\build.bat` — builds `VT_Importer.prm` (additionally requires the Premiere Pro C++ SDK at `Premiere_Pro_24.0_C++_Win_SDK\...`, which is **not** committed). Install the `.prm` to `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\VibeTools\`.
- `VT_ControlSurface` builds from `native\VT_ControlSurface\VT_ControlSurface.sln` (also needs the SDK); output `.acsrf`.

## Conventions & gotchas

- **ExtendScript has no `JSON`** — a polyfill is defined at the top of `hostscript.jsx`; keep it first.
- **Bump `VT_SCRIPT_VERSION`** (top of `hostscript.jsx`) when changing host script behavior — Premiere aggressively caches ExtendScript, and the version badge in the Debug panel is how you confirm a reload took.
- **`ExternalObject` can only be loaded once per Premiere session** — the reference is cached on `$.global.VT_ExtObj` (`VT_initExtObj`). To pick up a *rebuilt DLL you must fully restart Premiere*; ExtendScript changes alone can be hot-reloaded via the Debug panel's "Reload ExtendScript" button (re-runs `$.evalFile` on `hostscript.jsx`).
- **`window._vtBusy` / `setVtBusy()`** gate `evalScript` calls during critical drag-drop operations to avoid reentrancy.
- **Debugging:** there is an in-panel collapsible Debug panel (toggle in Settings). ExtendScript also logs to `%TEMP%\vibetool_debug.txt` via `vtLog()` (survives engine crashes that lose `$.writeln` output); read it back from the panel via `VT_readDebugLog`. CEP remote debugging is enabled by the manifest's CEF flags.
- **Manifest CEF flags** (`CSXS/manifest.xml`): `--enable-nodejs`, `--mixed-context`, `--allow-file-access(-from-files)` — Node and mixed context are required for `main.js` to work.
- **Scratch/non-build files** (e.g. `*.bak`, `*.broken`, `*.staged`, `temp*.js`) are not part of the product and are gitignored.
