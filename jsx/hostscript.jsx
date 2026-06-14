/**
 * VibeTools - ExtendScript Host Script
 * Handles Premiere Pro API calls
 */

// JSON polyfill for ExtendScript - MUST BE BEFORE any JSON usage!
if (typeof JSON === 'undefined') {
    JSON = {
        parse: function (str) {
            return eval('(' + str + ')');
        },
        stringify: function (obj) {
            var type = typeof obj;
            if (type !== 'object' || obj === null) {
                if (type === 'string') return '"' + obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
                return String(obj);
            }
            var arr = obj instanceof Array;
            var parts = [];
            for (var k in obj) {
                if (obj.hasOwnProperty(k)) {
                    var v = JSON.stringify(obj[k]);
                    parts.push(arr ? v : '"' + k + '":' + v);
                }
            }
            return arr ? '[' + parts.join(',') + ']' : '{' + parts.join(',') + '}';
        }
    };
}

// DEBUG FILE LOGGER - survives engine crashes where $.writeln doesn't flush
var VT_LOG = Folder.temp + '/vibetool_debug.txt';
function vtLog(msg) {
    try {
        var f = new File(VT_LOG);
        f.open('a');
        f.write(new Date().toTimeString() + ' ' + msg + '\n');
        f.close();
    } catch (e) {}
}

// VERSION for debugging cache issues - AFTER JSON polyfill!
var VT_SCRIPT_VERSION = '3.2.1'; // DLL v11: CS+keyboard, long return, .rdata, targeting OK
vtLog('=== SCRIPT LOADED v' + VT_SCRIPT_VERSION + ' ===');

// Clip label colors (Premiere label index per asset type)
var LABEL_COLORS = {
    video:       1,  // Iris
    audio:       3,  // Cerulean
    mogrt:       2,  // Rose
    transition:  7,  // Mint
    text:        5,  // Canary
    effect:      6,  // Mango
    overlay:     4,  // Lavender
    background:  8,  // Forest
    other:       0   // None
};

// Name of the bin where imported assets go
var VT_ASSETS_BIN_NAME = 'VibeAssets';

/**
 * Get or create the VibeAssets bin for organizing imported assets
 * @returns {ProjectItem} - The VibeAssets bin
 */
function VT_getOrCreateAssetsBin() {
    var rootItem = app.project.rootItem;

    // Search for existing bin
    for (var i = 0; i < rootItem.children.numItems; i++) {
        var child = rootItem.children[i];
        if (child.type === 2 && child.name === VT_ASSETS_BIN_NAME) { // type 2 = bin
            return child;
        }
    }

    // Create new bin if not found
    return rootItem.createBin(VT_ASSETS_BIN_NAME);
}

/**
 * Scale clips to fit the sequence frame size
 * @param {Array} clips - Array of clips to scale
 * @param {Sequence} seq - Target sequence
 */
function VT_scaleClipsToFit(clips, seq) {
    if (!clips || !seq) return;

    var seqWidth = seq.frameSizeHorizontal;
    var seqHeight = seq.frameSizeVertical;

    vtLog('VT_scaleClipsToFit: Sequence size = ' + seqWidth + 'x' + seqHeight);

    for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        if (!clip) continue;

        try {
            // Skip audio clips
            if (!clip.components) continue;

            // Skip adjustment layers and MGT (Motion Graphics Templates)
            if (clip.isAdjustmentLayer && clip.isAdjustmentLayer()) continue;
            if (clip.isMGT && clip.isMGT()) continue;

            // Get clip dimensions from QE
            var clipWidth = 1920;  // default
            var clipHeight = 1080; // default

            if (typeof qe !== 'undefined' && qe && qe.project) {
                try {
                    var qeSeq = qe.project.getActiveSequence();
                    if (qeSeq) {
                        // Find matching QE clip by position
                        for (var t = 0; t < qeSeq.numVideoTracks; t++) {
                            var track = qeSeq.getVideoTrackAt(t);
                            for (var c = 0; c < track.numItems; c++) {
                                var qeClip = track.getItemAt(c);
                                if (qeClip && qeClip.name === clip.name) {
                                    try {
                                        var projItem = qeClip.getProjectItem();
                                        if (projItem && projItem.clip) {
                                            clipWidth = projItem.clip.videoFrameWidth || 1920;
                                            clipHeight = projItem.clip.videoFrameHeight || 1080;
                                        }
                                    } catch (e) { }
                                    break;
                                }
                            }
                        }
                    }
                } catch (qeErr) {
                    vtLog('VT_scaleClipsToFit: QE error: ' + qeErr);
                }
            }

            // Calculate scale factors
            var scaleX = seqWidth / clipWidth;
            var scaleY = seqHeight / clipHeight;
            // Use "cover" mode - fill frame completely (may crop)
            var targetScale = Math.max(scaleX, scaleY) * 100;

            vtLog('VT_scaleClipsToFit: ' + clip.name + ' (' + clipWidth + 'x' + clipHeight + ') -> scale ' + Math.round(targetScale) + '%');

            // Find Motion effect and set Scale
            var effects = clip.components;
            for (var e = 0; e < effects.numItems; e++) {
                if (effects[e].matchName === 'AE.ADBE Motion') {
                    // Scale is usually property index 1
                    var scaleProperty = effects[e].properties[1];
                    if (scaleProperty) {
                        scaleProperty.setValue(targetScale, true);
                        vtLog('VT_scaleClipsToFit: Applied scale ' + Math.round(targetScale) + '% to ' + clip.name);
                    }
                    break;
                }
            }
        } catch (clipErr) {
            vtLog('VT_scaleClipsToFit: Error scaling clip: ' + clipErr);
        }
    }
}

/**
 * Warmup function to force ExtendScript JIT compilation of critical paths
 * This runs through all critical code WITHOUT side effects to ensure first real call works
 * @returns {string} - JSON with warmup status
 */
function VT_warmupCriticalPaths() {
    var status = {
        jsonOk: false,
        timeOk: false,
        seqOk: false,
        dllOk: false,
        parseOk: false,
        version: VT_SCRIPT_VERSION
    };

    try {
        // 1. Test JSON stringify/parse (critical for parameter passing)
        var testObj = { test: 123, str: "hello", arr: [1, 2, 3] };
        var jsonStr = JSON.stringify(testObj);
        var parsed = JSON.parse(jsonStr);
        status.jsonOk = (parsed.test === 123);

        // 2. Test Time object (critical for setPlayerPosition)
        try {
            var t = new Time();
            t.seconds = 10.5;
            var ticks = t.ticks;
            status.timeOk = (ticks > 0 || ticks === 0);
        } catch (timeErr) {
            status.timeOk = false;
        }

        // 3. Test sequence access (critical for VT_replacePlaceholderWithAsset)
        try {
            var seq = app.project.activeSequence;
            status.seqOk = (seq !== null && seq !== undefined);
            if (seq) {
                // Access properties to force them to be compiled
                var numV = seq.videoTracks.numTracks;
                var numA = seq.audioTracks.numTracks;
                var seqId = seq.sequenceID;
            }
        } catch (seqErr) {
            status.seqOk = false;
        }

        // 4. Test DLL initialization
        status.dllOk = VT_initExtObj();

        // 5. Test parseInt/parseFloat (critical for position handling)
        var testTicks = parseInt("12345678901234", 10);
        var testSeconds = parseFloat("123.456");
        status.parseOk = (!isNaN(testTicks) && !isNaN(testSeconds));

        // 6. CRITICAL: Warmup VT_getOrCreateAssetsBin (used in VT_replacePlaceholderWithAsset)
        status.binOk = false;
        try {
            var bin = VT_getOrCreateAssetsBin();
            status.binOk = (bin !== null && bin !== undefined);
        } catch (binErr) {
            status.binOk = false;
            vtLog('VT_warmupCriticalPaths: bin warmup failed: ' + binErr);
        }

        // 7. Check DLL is loaded (but DON'T call it - that crashes on first use!)
        // The main function VT_replacePlaceholderWithAsset will handle DLL calls
        // with its own retry logic
        status.cmdOk = false;
        try {
            // Just check the ExternalObject exists and DLL is loaded
            status.cmdOk = VT_initExtObj();
            vtLog('VT_warmupCriticalPaths: DLL loaded = ' + status.cmdOk);
        } catch (cmdErr) {
            vtLog('VT_warmupCriticalPaths: DLL check error: ' + cmdErr);
            status.cmdOk = false;
        }

        // 8. Access app.project.sequences (used for finding imported sequence)
        status.seqListOk = false;
        try {
            var numSeqs = app.project.sequences.numSequences;
            status.seqListOk = (numSeqs >= 0);
        } catch (seqListErr) {
            status.seqListOk = false;
        }

        // 9. Test QE access
        status.qeOk = false;
        try {
            if (typeof qe !== 'undefined' && qe && qe.project) {
                var qeSeq = qe.project.getActiveSequence();
                status.qeOk = (qeSeq !== null && qeSeq !== undefined);
            }
        } catch (qeErr) {
            status.qeOk = false;
        }

    } catch (e) {
        vtLog('VT_warmupCriticalPaths error: ' + e);
    }

    vtLog('VT_warmupCriticalPaths: ' + JSON.stringify(status));
    return JSON.stringify(status);
}

/**
 * Get script version to verify Premiere is loading the correct code
 */
function VT_getVersion() {
    // Use simple string concatenation to avoid any JSON issues
    return '{"version":"' + VT_SCRIPT_VERSION + '","message":"ExtendScript loaded OK!"}';
}

/**
 * Test what methods are available on QE objects
 * Looking for executeCommand or similar
 */
function VT_testQEMethods() {
    var result = {
        qeAvailable: false,
        qeMethods: [],
        qeProjectMethods: [],
        qeSeqMethods: [],
        appMethods: [],
        interestingMethods: []
    };

    try {
        // Check app object for executeCommand/menuCommand
        if (typeof app !== 'undefined' && app) {
            for (var a in app) {
                if (a.toLowerCase().indexOf('command') !== -1 ||
                    a.toLowerCase().indexOf('execute') !== -1 ||
                    a.toLowerCase().indexOf('menu') !== -1 ||
                    a.toLowerCase().indexOf('paste') !== -1) {
                    result.appMethods.push(a);
                    result.interestingMethods.push('app.' + a);
                }
            }
        }

        // Check if qe exists
        if (typeof qe !== 'undefined' && qe) {
            result.qeAvailable = true;

            // Get methods on qe object
            for (var k in qe) {
                result.qeMethods.push(k);
                if (k.toLowerCase().indexOf('command') !== -1 ||
                    k.toLowerCase().indexOf('execute') !== -1 ||
                    k.toLowerCase().indexOf('paste') !== -1) {
                    result.interestingMethods.push('qe.' + k);
                }
            }

            // Get methods on qe.project
            if (qe.project) {
                for (var p in qe.project) {
                    result.qeProjectMethods.push(p);
                    if (p.toLowerCase().indexOf('command') !== -1 ||
                        p.toLowerCase().indexOf('execute') !== -1 ||
                        p.toLowerCase().indexOf('paste') !== -1) {
                        result.interestingMethods.push('qe.project.' + p);
                    }
                }

                // Get methods on active sequence
                try {
                    var qeSeq = qe.project.getActiveSequence();
                    if (qeSeq) {
                        for (var s in qeSeq) {
                            result.qeSeqMethods.push(s);
                            if (s.toLowerCase().indexOf('command') !== -1 ||
                                s.toLowerCase().indexOf('execute') !== -1 ||
                                s.toLowerCase().indexOf('paste') !== -1) {
                                result.interestingMethods.push('qeSeq.' + s);
                            }
                        }
                    }
                } catch (seqErr) {
                    result.qeSeqMethods.push('ERROR: ' + seqErr);
                }
            }
        }
    } catch (e) {
        result.error = e.toString();
    }

    return JSON.stringify(result);
}



// ========================================
// Native ExternalObject DLL for Commands
// Use $.global to persist ExternalObject reference across script reloads
// This is critical - ExternalObject can only be loaded once per session
// Safe initialization - check $.global exists first
try {
    if (typeof $.global === 'undefined') {
        $.global = {};
    }
    if (typeof $.global.VT_ExtObj === 'undefined') {
        $.global.VT_ExtObj = null;
    }
} catch (globalErr) {
    // $.global failed - engine not ready, will retry on next call
}
var VT_ExtensionPath = null;

/**
 * Get the extension root path
 */
function VT_getExtensionPath() {
    if (VT_ExtensionPath) return VT_ExtensionPath;

    // Try different methods to get extension path
    var scriptPath = $.fileName;
    vtLog('VT_getExtensionPath: $.fileName = ' + scriptPath);

    if (scriptPath && scriptPath.indexOf('jsx') !== -1) {
        // Remove /jsx/hostscript.jsx from end
        VT_ExtensionPath = scriptPath.replace(/[\\\/]jsx[\\\/][^\\\/]+$/, '');

        // Decode URL encoding (%20 -> space, etc)
        VT_ExtensionPath = decodeURI(VT_ExtensionPath);

        // Convert URL-style path to Windows path
        // /c/Program Files -> C:/Program Files
        if (VT_ExtensionPath.match(/^\/[a-zA-Z]\//)) {
            var driveLetter = VT_ExtensionPath.charAt(1).toUpperCase();
            VT_ExtensionPath = driveLetter + ':' + VT_ExtensionPath.substring(2);
        }
    } else {
        // Fallback: hardcode path
        VT_ExtensionPath = 'C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/VibeTool';
    }

    vtLog('VT_getExtensionPath: Extension path = ' + VT_ExtensionPath);
    return VT_ExtensionPath;
}

/**
 * Get path to our DLL
 */
function VT_getDllPath() {
    var extPath = VT_getExtensionPath();

    if ($.os.indexOf('Windows') !== -1) {
        return extPath.replace(/\\/g, '/') + '/support_files/VT_ExternalObject';
    } else {
        return extPath + '/support_files/VT_ExternalObject';
    }
}

/**
 * Test function to debug DLL loading
 */
function VT_testDllPath() {
    var dllPath = VT_getDllPath();
    var fullPath = dllPath + '.dll';
    var testFile = new File(fullPath);

    return JSON.stringify({
        scriptPath: $.fileName,
        extensionPath: VT_getExtensionPath(),
        dllPath: dllPath,
        fullPath: fullPath,
        exists: testFile.exists
    });
}

/**
 * Initialize the ExternalObject DLL
 * Handles cold start scenario where $.global may not be fully ready
 */
function VT_initExtObj() {
    vtLog('VT_initExtObj: Starting...');
    try {
        if ($.global.VT_ExtObj) {
            var hasCmd = (typeof $.global.VT_ExtObj.doCommand === 'function');
            vtLog('VT_initExtObj: Already exists, doCommand=' + hasCmd);
            return hasCmd;
        }
        var dllPath = VT_getDllPath();
        vtLog('VT_initExtObj: Loading DLL from ' + dllPath);
        $.global.VT_ExtObj = new ExternalObject('lib:' + dllPath);
        if (!$.global.VT_ExtObj || typeof $.global.VT_ExtObj.doCommand !== 'function') {
            vtLog('VT_initExtObj: doCommand not found');
            return false;
        }
        vtLog('VT_initExtObj: DLL loaded OK (persistent)');
        return true;
    } catch (e) {
        vtLog('VT_initExtObj ERROR: ' + e);
        return false;
    }
}

/**
 * Execute a command via native DLL
 * @param {string} command - Command to execute (e.g. 'cmd.edit.copy', 'cmd.edit.paste')
 * @returns {boolean} - true on success, false on failure
 */
function VT_executeCommand(command) {
    vtLog('CMD: ' + command);
    try {
        if (!$.global.VT_ExtObj || typeof $.global.VT_ExtObj.doCommand !== 'function') {
            vtLog('CMD: DLL not loaded, reinitializing...');
            if (!VT_initExtObj()) {
                vtLog('CMD: DLL init failed');
                return false;
            }
        }
        $.global.VT_ExtObj.doCommand(command);
        vtLog('CMD: OK');
        return true;
    } catch (e) {
        vtLog('CMD: ERROR: ' + e);
        return false;
    }
}

// Track Targeting Helpers 
function VT_saveTrackTargeting(seq) {
    var video = [];
    var audio = [];
    for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
        video[sv] = seq.videoTracks[sv].isTargeted();
    }
    for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
        audio[sa] = seq.audioTracks[sa].isTargeted();
    }
    return { video: video, audio: audio };
}

function VT_restoreTrackTargeting(seq, saved) {
    for (var rv = 0; rv < seq.videoTracks.numTracks && rv < saved.video.length; rv++) {
        seq.videoTracks[rv].setTargeted(saved.video[rv], true);
    }
    for (var ra = 0; ra < seq.audioTracks.numTracks && ra < saved.audio.length; ra++) {
        seq.audioTracks[ra].setTargeted(saved.audio[ra], true);
    }
}

function VT_setTrackTargeting(seq, videoIdx, audioIdx) {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        seq.videoTracks[v].setTargeted(v === videoIdx, true);
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        seq.audioTracks[a].setTargeted(a === audioIdx, true);
    }
}

/**
 * 3-CALL DRAG-DROP ARCHITECTURE (v3.2.0 - persistent DLL)
 *
 * ExtObj is created once and stored in $.global.VT_ExtObj.
 * No per-call create/unload this was causing DLL crashes.
 *
 * Call 1: VT_prepareDragDrop()   -> API only (import, open, select)
 * Call 2: VT_copyAndSwitch()     -> DLL FIRST (copy), then API (switch seq)
 * Call 3: VT_pasteAndFinalize()  -> DLL FIRST (paste), then API (finalize)
 *
 * State is stored in $.global.VT_DragState between calls.
 * DLL calls are always FIRST in each evalScript call.
 */

/**
 * CALL 1: Prepare - Pure API, zero DLL calls
 * Import .prproj, open imported sequence, select clips.
 * Stores state in $.global.VT_DragState for subsequent calls.
 */
function VT_prepareDragDrop(assetPath, placeholderInfo, assetType) {
    vtLog('DRAG-1: START type=' + (assetType || '?'));
    try {
        // Verify DLL is loaded (but do NOT call it - that is for Call 2/3)
        if (!VT_initExtObj()) {
            vtLog('DRAG-1: DLL NOT AVAILABLE');
            return JSON.stringify({ success: false, error: 'DLL not available' });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            vtLog('DRAG-1: NO SEQ');
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        var insertPositionTicks = parseInt(placeholderInfo.startTicks, 10);
        var insertPositionSeconds = parseFloat(placeholderInfo.startSeconds);
        var targetTrackIndex = parseInt(placeholderInfo.trackIndex, 10);
        if (isNaN(insertPositionTicks) || isNaN(insertPositionSeconds) || isNaN(targetTrackIndex)) {
            vtLog('DRAG-1: INVALID POS');
            return JSON.stringify({ success: false, error: 'Invalid position values' });
        }

        // Remove placeholder
        vtLog('DRAG-1: remove placeholder');
        try {
            if (placeholderInfo.isVideo) {
                var vtrack = seq.videoTracks[placeholderInfo.trackIndex];
                if (vtrack && vtrack.clips.numItems > placeholderInfo.clipIndex) {
                    var clipToRemove = vtrack.clips[placeholderInfo.clipIndex];
                    if (clipToRemove && clipToRemove.name && clipToRemove.name.match(/\.vtbk$/i)) {
                        clipToRemove.remove(false, false);
                    }
                }
            }
        } catch (removeErr) {
            if (typeof qe !== 'undefined' && qe && qe.project) {
                try { qe.project.undo(); } catch (ue) { }
            }
        }

        // Set playhead
        try {
            seq.setPlayerPosition(insertPositionTicks);
        } catch (tickErr) {
            var posTime = new Time();
            posTime.seconds = insertPositionSeconds;
            seq.setPlayerPosition(posTime.ticks);
        }

        // Save targeting
        vtLog('DRAG-1: save targeting');
        var savedTargeting = VT_saveTrackTargeting(seq);

        // Set targeting to placeholder track
        VT_setTrackTargeting(seq, targetTrackIndex, targetTrackIndex);

        // Import .prproj
        vtLog('DRAG-1: import prproj');
        var existingSeqIds = {};
        for (var s = 0; s < app.project.sequences.numSequences; s++) {
            existingSeqIds[app.project.sequences[s].sequenceID] = true;
        }

        var assetsBin = VT_getOrCreateAssetsBin();
        app.project.importFiles([assetPath], true, assetsBin, false);
        vtLog('DRAG-1: imported');

        // Find imported sequence
        var importedSeq = null;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var importSeq = app.project.sequences[i];
            if (!existingSeqIds[importSeq.sequenceID]) {
                importedSeq = importSeq;
                break;
            }
        }

        if (!importedSeq) {
            vtLog('DRAG-1: NO IMPORTED SEQ');
            return JSON.stringify({ success: false, error: 'Could not find imported sequence' });
        }
        vtLog('DRAG-1: found seq=' + importedSeq.name);

        // Collect clips, disable
        vtLog('DRAG-1: collect + disable');
        var clipsToSelect = [];
        for (var vt2 = 0; vt2 < importedSeq.videoTracks.numTracks; vt2++) {
            var vTrack = importedSeq.videoTracks[vt2];
            for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                var vclip = vTrack.clips[vc];
                clipsToSelect.push(vclip);
                vclip.disabled = true;
            }
        }
        for (var at2 = 0; at2 < importedSeq.audioTracks.numTracks; at2++) {
            var aTrack = importedSeq.audioTracks[at2];
            for (var ac2 = 0; ac2 < aTrack.clips.numItems; ac2++) {
                clipsToSelect.push(aTrack.clips[ac2]);
            }
        }

        if (clipsToSelect.length === 0) {
            vtLog('DRAG-1: NO CLIPS');
            return JSON.stringify({ success: false, error: 'No clips in asset' });
        }
        vtLog('DRAG-1: ' + clipsToSelect.length + ' clips');

        // Open imported sequence and select clips (Nemo-style: sleep after openSequence)
        vtLog('DRAG-1: open + select');
        app.project.openSequence(importedSeq.sequenceID);
        $.sleep(20);
        importedSeq.setSelection(clipsToSelect);

        // Store state for subsequent steps
        $.global.VT_DragState = {
            importedSeqId: importedSeq.sequenceID,
            targetSeqId: seq.sequenceID,
            insertPositionTicks: String(insertPositionTicks),
            insertPositionSeconds: insertPositionSeconds,
            targetTrackIndex: targetTrackIndex,
            savedTargeting: savedTargeting,
            clipsCount: clipsToSelect.length,
            assetType: assetType || ''
        };

        vtLog('DRAG-1: DONE (state saved)');
        return JSON.stringify({ success: true, clipsCount: clipsToSelect.length });

    } catch (e) {
        vtLog('DRAG-1: ERROR: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * CALL 2: Copy + Switch - DLL FIRST (clean engine), then API
 * DLL is persistent (no crash). Then switches to target sequence.
 */
function VT_copyAndSwitch() {
    vtLog('DRAG-2: START');
    try {
        var state = $.global.VT_DragState;
        if (!state) {
            vtLog('DRAG-2: NO STATE');
            return JSON.stringify({ success: false, error: 'No drag state' });
        }

        // === DLL FIRST - engine is clean at this point ===
        vtLog('DRAG-2: DLL copy');
        var copyResult = VT_executeCommand('cmd.edit.copy');
        vtLog('DRAG-2: copy=' + copyResult);

        // === API operations after DLL ===
        vtLog('DRAG-2: close imported');
        try {
            for (var i = 0; i < app.project.sequences.numSequences; i++) {
                if (app.project.sequences[i].sequenceID === state.importedSeqId) {
                    try { app.project.sequences[i].close(); } catch (e) { }
                    break;
                }
            }
        } catch (e) { vtLog('DRAG-2: close warn: ' + e); }

        vtLog('DRAG-2: switch to target');
        app.project.openSequence(state.targetSeqId);

        if (typeof qe !== 'undefined' && qe && qe.project) {
            try { qe.project.getActiveSequence().makeCurrent(); } catch (e) { }
        }

        // Re-apply targeting after openSequence
        vtLog('DRAG-2: re-apply targeting to track ' + state.targetTrackIndex);
        var targetSeq = app.project.activeSequence;
        if (targetSeq) {
            var ti = state.targetTrackIndex;
            VT_setTrackTargeting(targetSeq, ti, ti);

            // Set playhead
            vtLog('DRAG-2: set playhead');
            try {
                targetSeq.setPlayerPosition(parseInt(state.insertPositionTicks, 10));
            } catch (tickErr) {
                var t2 = new Time();
                t2.seconds = state.insertPositionSeconds;
                targetSeq.setPlayerPosition(t2.ticks);
            }
        }

        vtLog('DRAG-2: DONE (targeting on V' + (state.targetTrackIndex + 1) + ')');
        return JSON.stringify({ success: true });

    } catch (e) {
        vtLog('DRAG-2: ERROR: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * CALL 3: Paste + Finalize - DLL FIRST (clean engine), then API
 * DLL is persistent (no crash). Then finalizes.
 */
function VT_pasteAndFinalize() {
    vtLog('DRAG-3: START');
    try {
        var state = $.global.VT_DragState;
        if (!state) {
            vtLog('DRAG-3: NO STATE');
            return JSON.stringify({ success: false, error: 'No drag state' });
        }

        // === DLL FIRST - engine is clean at this point ===
        vtLog('DRAG-3: DLL paste');
        var pasteResult = VT_executeCommand('cmd.edit.paste');
        vtLog('DRAG-3: paste=' + pasteResult);

        // === API operations after DLL ===
        var targetSeq = app.project.activeSequence;
        if (!targetSeq) {
            vtLog('DRAG-3: NO ACTIVE SEQ');
            return JSON.stringify({ success: false, error: 'No active sequence after paste' });
        }

        // Restore targeting
        vtLog('DRAG-3: restore targeting');
        VT_restoreTrackTargeting(targetSeq, state.savedTargeting);

        // Re-enable pasted clips
        vtLog('DRAG-3: re-enable');
        var pastedClipsCount = 0;
        try {
            var pastedClips = targetSeq.getSelection();
            for (var ps = 0; ps < pastedClips.length; ps++) {
                pastedClips[ps].disabled = false;
                if (state.assetType && LABEL_COLORS[state.assetType]) {
                    pastedClips[ps].label = LABEL_COLORS[state.assetType];
                }
                pastedClipsCount++;
            }
        } catch (ee) { vtLog('DRAG-3: re-enable warn: ' + ee); }

        // Scale to fit
        vtLog('DRAG-3: scale');
        try { VT_scaleClipsToFit(targetSeq.getSelection(), targetSeq); } catch (se) { vtLog('DRAG-3: scale warn: ' + se); }

        // Cleanup imported sequence
        vtLog('DRAG-3: cleanup');
        try {
            var allSeqs = app.project.sequences;
            for (var ci = 0; ci < allSeqs.numSequences; ci++) {
                if (allSeqs[ci].sequenceID === state.importedSeqId) {
                    try { allSeqs[ci].close(); } catch (e) { }
                    try { app.project.deleteSequence(allSeqs[ci]); } catch (e) {
                        try {
                            var delBin = app.project.rootItem.createBin('_vt_delete_');
                            qe.project.undo();
                            allSeqs[ci].projectItem.moveBin(delBin);
                            delBin.deleteBin();
                        } catch (e2) { }
                    }
                    break;
                }
            }
        } catch (ce) { vtLog('DRAG-3: cleanup warn: ' + ce); }

        // Cleanup placeholders from bin
        try { VT_cleanupPlaceholdersFromBin(); } catch (e) { }

        // Clear state
        $.global.VT_DragState = null;

        vtLog('DRAG-3: SUCCESS! (' + pastedClipsCount + ' clips)');
        return JSON.stringify({ success: true, clipsCount: pastedClipsCount });

    } catch (e) {
        vtLog('DRAG-3: ERROR: ' + e);
        $.global.VT_DragState = null;
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ========================================
// EVENT PAUSING
// Prevents cascading Premiere events during critical drag-drop operations
// ========================================
function VT_pauseEvents() {
    $.global.VT_EventsPausedUntil = Date.now() + 8000;
    vtLog('EVENTS: paused');
}
function VT_unpauseEvents() {
    $.global.VT_EventsPausedUntil = 0;
    vtLog('EVENTS: unpaused');
}
function VT_areEventsPaused() {
    return ($.global.VT_EventsPausedUntil > 0 && $.global.VT_EventsPausedUntil >= Date.now());
}

// Init the timer on global
if (!$.global.VT_EventsPausedUntil) $.global.VT_EventsPausedUntil = 0;

/**
 * SINGLE-CALL drag-drop: does everything in one evalScript round-trip.
 * Equivalent to prepareDragDrop + copyAndSwitch + pasteAndFinalize combined.
 */
function VT_dragDropSingleCall(assetPath, placeholderInfo, assetType) {
    vtLog('DRAG-SINGLE: START type=' + (assetType || '?'));
    VT_pauseEvents();
    try {
        if (!VT_initExtObj()) {
            return JSON.stringify({ success: false, error: 'DLL not available' });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        var insertPositionTicks = parseInt(placeholderInfo.startTicks, 10);
        var insertPositionSeconds = parseFloat(placeholderInfo.startSeconds);
        var targetTrackIndex = parseInt(placeholderInfo.trackIndex, 10);
        if (isNaN(insertPositionTicks) || isNaN(insertPositionSeconds) || isNaN(targetTrackIndex)) {
            return JSON.stringify({ success: false, error: 'Invalid position values' });
        }

        var targetSeqId = seq.sequenceID;

        // Remove placeholder
        try {
            if (placeholderInfo.isVideo) {
                var vtrack = seq.videoTracks[placeholderInfo.trackIndex];
                if (vtrack && vtrack.clips.numItems > placeholderInfo.clipIndex) {
                    var clipToRemove = vtrack.clips[placeholderInfo.clipIndex];
                    if (clipToRemove && clipToRemove.name && clipToRemove.name.match(/\.vtbk$/i)) {
                        clipToRemove.remove(false, false);
                    }
                }
            }
        } catch (removeErr) {
            if (typeof qe !== 'undefined' && qe && qe.project) {
                try { qe.project.undo(); } catch (ue) { }
            }
        }

        // Save targeting
        var savedVideoTargeting = [];
        var savedAudioTargeting = [];
        for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
            savedVideoTargeting[sv] = seq.videoTracks[sv].isTargeted();
        }
        for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
            savedAudioTargeting[sa] = seq.audioTracks[sa].isTargeted();
        }

        // Import .prproj
        var existingSeqIds = {};
        for (var s = 0; s < app.project.sequences.numSequences; s++) {
            existingSeqIds[app.project.sequences[s].sequenceID] = true;
        }

        var assetsBin = VT_getOrCreateAssetsBin();
        app.project.importFiles([assetPath], true, assetsBin, false);

        // Find imported sequence
        var importedSeq = null;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var importSeq = app.project.sequences[i];
            if (!existingSeqIds[importSeq.sequenceID]) {
                importedSeq = importSeq;
                break;
            }
        }

        if (!importedSeq) {
            return JSON.stringify({ success: false, error: 'Could not find imported sequence' });
        }

        // Collect clips + disable
        var clipsToSelect = [];
        for (var vt2 = 0; vt2 < importedSeq.videoTracks.numTracks; vt2++) {
            var vTrack = importedSeq.videoTracks[vt2];
            for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                var vclip = vTrack.clips[vc];
                clipsToSelect.push(vclip);
                vclip.disabled = true;
            }
        }
        for (var at2 = 0; at2 < importedSeq.audioTracks.numTracks; at2++) {
            var aTrack = importedSeq.audioTracks[at2];
            for (var ac2 = 0; ac2 < aTrack.clips.numItems; ac2++) {
                clipsToSelect.push(aTrack.clips[ac2]);
            }
        }

        if (clipsToSelect.length === 0) {
            return JSON.stringify({ success: false, error: 'No clips in asset' });
        }

        // Open imported sequence, select, copy (no sleep needed)
        app.project.openSequence(importedSeq.sequenceID);
        importedSeq.setSelection(clipsToSelect);

        var copyResult = VT_executeCommand('cmd.edit.copy');
        vtLog('DRAG-SINGLE: copy=' + copyResult);

        // Switch back to target FIRST, then close imported (avoids a "dead" sequence state)
        app.project.openSequence(targetSeqId);
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try { qe.project.getActiveSequence().makeCurrent(); } catch (e) { }
        }
        try { importedSeq.close(); } catch (e) { }

        // Re-apply targeting
        var targetSeq = app.project.activeSequence;
        for (var vt = 0; vt < targetSeq.videoTracks.numTracks; vt++) {
            targetSeq.videoTracks[vt].setTargeted(vt === targetTrackIndex, true);
        }
        for (var at = 0; at < targetSeq.audioTracks.numTracks; at++) {
            targetSeq.audioTracks[at].setTargeted(at === targetTrackIndex, true);
        }

        // Set playhead
        try {
            targetSeq.setPlayerPosition(insertPositionTicks);
        } catch (tickErr) {
            var posTime = new Time();
            posTime.seconds = insertPositionSeconds;
            targetSeq.setPlayerPosition(posTime.ticks);
        }

        // Paste
        var pasteResult = VT_executeCommand('cmd.edit.paste');
        vtLog('DRAG-SINGLE: paste=' + pasteResult);

        // Restore targeting
        for (var rv = 0; rv < targetSeq.videoTracks.numTracks && rv < savedVideoTargeting.length; rv++) {
            targetSeq.videoTracks[rv].setTargeted(savedVideoTargeting[rv], true);
        }
        for (var ra = 0; ra < targetSeq.audioTracks.numTracks && ra < savedAudioTargeting.length; ra++) {
            targetSeq.audioTracks[ra].setTargeted(savedAudioTargeting[ra], true);
        }

        // Re-enable pasted clips
        var pastedClipsCount = 0;
        try {
            var pastedClips = targetSeq.getSelection();
            for (var ps = 0; ps < pastedClips.length; ps++) {
                pastedClips[ps].disabled = false;
                if (assetType && LABEL_COLORS[assetType]) {
                    pastedClips[ps].label = LABEL_COLORS[assetType];
                }
                pastedClipsCount++;
            }
        } catch (ee) { vtLog('DRAG-SINGLE: re-enable warn: ' + ee); }

        // Scale to fit
        try { VT_scaleClipsToFit(targetSeq.getSelection(), targetSeq); } catch (se) { }

        // Cleanup imported sequence
        try {
            app.project.deleteSequence(importedSeq);
        } catch (e1) {
            try {
                var delBin = app.project.rootItem.createBin('_vt_delete_');
                if (typeof qe !== 'undefined' && qe && qe.project) { qe.project.undo(); }
                importedSeq.projectItem.moveBin(delBin);
                delBin.deleteBin();
            } catch (e2) { }
        }

        try { VT_cleanupPlaceholdersFromBin(); } catch (e) { }

        vtLog('DRAG-SINGLE: SUCCESS! (' + pastedClipsCount + ' clips)');
        VT_unpauseEvents();
        return JSON.stringify({ success: true, clipsCount: pastedClipsCount });

    } catch (e) {
        vtLog('DRAG-SINGLE: ERROR: ' + e);
        VT_unpauseEvents();
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * Check if there are selected clips on the timeline
 */
function VT_hasSelection() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return 'false';
        }

        var selection = seq.getSelection();
        if (selection && selection.length > 0) {
            return 'true';
        }

        return 'false';
    } catch (e) {
        vtLog('VT_hasSelection error: ' + e);
        return 'false';
    }
}


/**
 * Cleanup .vtbk placeholder files from project bin
 * Called after successful asset insertion to remove leftover placeholders
 */
function VT_cleanupPlaceholdersFromBin() {
    var removedCount = 0;
    var vtbkPattern = /(\.vtbk|vt_drag_\d+\.(mp3|wav|m4a|aac|ogg|aiff|flac))$/i;

    // Recursive function to find and delete .vtbk items
    function searchAndDeleteInBin(parentItem) {
        if (!parentItem || !parentItem.children) return;

        // Iterate backwards to avoid index issues when deleting
        for (var i = parentItem.children.numItems - 1; i >= 0; i--) {
            var child = parentItem.children[i];

            if (child.type === 2) { // Bin
                searchAndDeleteInBin(child);
            } else if (child.name && child.name.match(vtbkPattern)) {
                try {
                    vtLog('VT_cleanupPlaceholdersFromBin: Deleting ' + child.name);
                    // Move to trash bin and delete
                    var trashBin = app.project.rootItem.createBin('_vt_trash_' + Date.now());
                    child.moveBin(trashBin);
                    trashBin.deleteBin();
                    removedCount++;
                } catch (delErr) {
                    vtLog('VT_cleanupPlaceholdersFromBin: Could not delete ' + child.name + ': ' + delErr);
                }
            }
        }
    }

    try {
        searchAndDeleteInBin(app.project.rootItem);
        vtLog('VT_cleanupPlaceholdersFromBin: Removed ' + removedCount + ' placeholder(s)');
    } catch (e) {
        vtLog('VT_cleanupPlaceholdersFromBin error: ' + e);
    }

    return removedCount;
}

/**
 * Find placeholder clip on timeline (for drag & drop)
 * Searches for .vtbk clips created by VT_Importer
 * @returns {string} - JSON with placeholder info or 'null' if not found
 */
function VT_findPlaceholder() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return 'null';

        // Pattern to match .vtbk placeholder files and native temp audio files
        var vtbkPattern = /\.vtbk$/i;
        var vtDragPattern = /vt_drag_\d+\.(vtbk|mp3|wav|m4a|aac|ogg|aiff|flac)$/i;

        // Search video tracks for placeholder
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var track = seq.videoTracks[vt];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.name && (clip.name.match(vtbkPattern) || clip.name.match(vtDragPattern))) {
                    vtLog('VT_findPlaceholder: Found .vtbk at V' + (vt + 1) + ', name: ' + clip.name + ', position: ' + clip.start.seconds);
                    return JSON.stringify({
                        trackIndex: vt,
                        clipIndex: c,
                        startTicks: String(clip.start.ticks), // STRING to avoid large number issues!
                        startSeconds: clip.start.seconds,
                        clipName: clip.name,
                        isVideo: true
                    });
                }
            }
        }

        // Search audio tracks
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var atrack = seq.audioTracks[at];
            for (var ac = 0; ac < atrack.clips.numItems; ac++) {
                var aclip = atrack.clips[ac];
                if (aclip.name && (aclip.name.match(vtbkPattern) || aclip.name.match(vtDragPattern))) {
                    vtLog('VT_findPlaceholder: Found .vtbk at A' + (at + 1));
                    return JSON.stringify({
                        trackIndex: at,
                        clipIndex: ac,
                        startTicks: String(aclip.start.ticks), // STRING to avoid large number issues!
                        startSeconds: aclip.start.seconds,
                        clipName: aclip.name,
                        isVideo: false
                    });
                }
            }
        }

        return 'null';
    } catch (e) {
        vtLog('VT_findPlaceholder error: ' + e);
        return 'null';
    }
}

/**
 * Save asset using native DLL - does everything in one ExtendScript call!
 * No PowerShell, no JS roundtrips
 * @param {string} outputPath - Path to save the .prproj file
 * @returns {string} - JSON with result details
 */
function VT_saveAssetNative(outputPath) {
    try {
        vtLog('VT_saveAssetNative: Starting save to ' + outputPath);

        // Ensure DLL is loaded
        if (!VT_initExtObj()) {
            return JSON.stringify({ success: false, error: 'DLL not available' });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        var selection = seq.getSelection();
        if (!selection || selection.length === 0) {
            return JSON.stringify({ success: false, error: 'No clips selected' });
        }

        vtLog('VT_saveAssetNative: Saving ' + selection.length + ' clip(s)');

        // Store current state
        var originalSeqId = seq.sequenceID;
        var originalPlayheadTicks = seq.getPlayerPosition().ticks;

        // IMPORTANT: Open sequence to ensure Premiere has focus (not CEP panel)
        // This is needed because user clicked button in CEP panel
        app.project.openSequence(originalSeqId);

        // Use QE API to ensure timeline is active
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try {
                qe.project.getActiveSequence().makeCurrent();
            } catch (qeErr) {
                vtLog('VT_saveAssetNative: QE warning: ' + qeErr);
            }
        }

        // Minimal delay for UI to update
        $.sleep(50);

        // COPY selection using native DLL
        vtLog('VT_saveAssetNative: Copying...');
        var copyResult = VT_executeCommand('cmd.edit.copy');
        vtLog('VT_saveAssetNative: Copy result = ' + copyResult);

        // Create temp sequence
        var tempSeqName = 'VT_Asset_' + new Date().getTime();

        // === IMPORT VIDEOSAMPLE FIRST ===
        // We'll use it as seed to create sequence (avoids New Sequence dialog)
        var extPath = VT_getExtensionPath();
        var videoSamplePath = extPath + '/VideoSampleLong.mp4';
        var videoSampleItem = null;

        vtLog('VT_saveAssetNative: Importing VideoSample from: ' + videoSamplePath);

        var videoSampleFile = new File(videoSamplePath);
        if (videoSampleFile.exists) {
            // Import to VibeAssets bin
            var assetsBin = VT_getOrCreateAssetsBin();
            app.project.importFiles([videoSamplePath], false, assetsBin, false);

            // Find the imported item
            for (var vi = 0; vi < assetsBin.children.numItems; vi++) {
                var child = assetsBin.children[vi];
                if (child.name === 'VideoSampleLong.mp4' || child.name === 'VideoSampleLong') {
                    videoSampleItem = child;
                    vtLog('VT_saveAssetNative: Found VideoSample: ' + videoSampleItem.name);
                    break;
                }
            }
        } else {
            vtLog('VT_saveAssetNative: WARNING - VideoSampleLong.mp4 not found at: ' + videoSamplePath);
        }

        // Create new sequence - use VideoSample as seed (no dialog!)
        var newSeq = null;

        if (videoSampleItem) {
            // Best option: use VideoSample to create sequence (VideoSample will be on V1)
            vtLog('VT_saveAssetNative: Creating sequence from VideoSample (no dialog)');
            try {
                newSeq = app.project.createNewSequenceFromClips(tempSeqName, [videoSampleItem], app.project.rootItem);
                vtLog('VT_saveAssetNative: Sequence created from VideoSample');
            } catch (seqErr) {
                vtLog('VT_saveAssetNative: createNewSequenceFromClips with VideoSample failed: ' + seqErr);
            }
        }

        // Fallback: try selection's projectItem
        if (!newSeq) {
            for (var i = 0; i < selection.length; i++) {
                if (selection[i].projectItem) {
                    try {
                        newSeq = app.project.createNewSequenceFromClips(tempSeqName, [selection[i].projectItem], app.project.rootItem);
                        vtLog('VT_saveAssetNative: Sequence created from selection projectItem');
                        break;
                    } catch (seqErr) {
                        vtLog('VT_saveAssetNative: createNewSequenceFromClips failed: ' + seqErr);
                    }
                }
            }
        }

        if (!newSeq) {
            // Last resort - this will show dialog
            vtLog('VT_saveAssetNative: ERROR - Could not create sequence without dialog. Missing VideoSampleLong.mp4?');
            return JSON.stringify({ success: false, error: 'Could not create sequence. Make sure VideoSampleLong.mp4 exists in extension folder.' });
        }

        var newSeqId = newSeq.sequenceID;

        // Find sequence project item for cleanup
        var seqProjectItem = null;
        for (var j = 0; j < app.project.rootItem.children.numItems; j++) {
            var child = app.project.rootItem.children[j];
            if (child.name === tempSeqName) {
                seqProjectItem = child;
                break;
            }
        }

        // Open new sequence
        app.project.openSequence(newSeqId);

        // NOTE: We do NOT clear clips here!
        // VideoSample from createNewSequenceFromClips is already on V1/A1
        // and we WANT it there for preview rendering
        vtLog('VT_saveAssetNative: VideoSample should be on V1 from sequence creation');

        // Count clips before paste (should include VideoSample)
        var clipsBefore = 0;
        for (var vt2 = 0; vt2 < newSeq.videoTracks.numTracks; vt2++) {
            clipsBefore += newSeq.videoTracks[vt2].clips.numItems;
        }
        vtLog('VT_saveAssetNative: Clips before paste = ' + clipsBefore);

        // Set playhead to beginning
        newSeq.setPlayerPosition('0');

        // === VIDEOSAMPLE IS ALREADY ON V1 ===
        // VideoSample was used as seed for sequence creation, so it's already on V1/A1
        // We just need to track the clips for later removal

        var videoSampleClip = null;
        var videoSampleAudioClip = null;

        // VideoSample should be the first clip on V1 (from createNewSequenceFromClips)
        if (newSeq.videoTracks[0].clips.numItems > 0) {
            videoSampleClip = newSeq.videoTracks[0].clips[0];
            vtLog('VT_saveAssetNative: VideoSample video clip found on V1');
        }

        // Audio should be on A1
        if (newSeq.audioTracks[0].clips.numItems > 0) {
            videoSampleAudioClip = newSeq.audioTracks[0].clips[0];
            vtLog('VT_saveAssetNative: VideoSample audio clip found on A1');
        }

        // Make sure we have at least 2 video tracks for V1 (sample) + V2+ (clips)
        while (newSeq.videoTracks.numTracks < 2) {
            vtLog('VT_saveAssetNative: Adding video track');
            // Premiere auto-adds tracks when needed, but entering clips on V2 will create it
        }

        // CRITICAL: Set track targeting to V2/A1 (skip V1 which has VideoSample)
        // This forces paste to land on V2 so user clips overlay the sample video
        vtLog('VT_saveAssetNative: Setting targeting to V2/A1...');
        VT_setTrackTargeting(newSeq, 1, 0);

        // Use QE API to ensure sequence is active in UI
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try {
                qe.project.getActiveSequence().makeCurrent();
            } catch (qeErr) {
                vtLog('VT_saveAssetNative: QE warning: ' + qeErr);
            }
        }

        // Minimal delay - drag & drop has none, but we need UI to catch up
        $.sleep(50);

        // PASTE using native DLL
        vtLog('VT_saveAssetNative: Pasting...');
        var pasteResult = VT_executeCommand('cmd.edit.paste');
        vtLog('VT_saveAssetNative: Paste result = ' + pasteResult);

        // Minimal wait for paste to complete
        $.sleep(50);

        // Count clips after paste
        var clipsAfter = 0;
        for (var vt3 = 0; vt3 < newSeq.videoTracks.numTracks; vt3++) {
            clipsAfter += newSeq.videoTracks[vt3].clips.numItems;
        }
        vtLog('VT_saveAssetNative: Clips after paste = ' + clipsAfter);

        // === RENDER PREVIEW ===
        // Now we have: V1 = VideoSample, V2+ = user clips with effects
        // Render this as preview before removing VideoSample
        var previewGenerated = false;
        var previewPath = outputPath.replace(/\.prproj$/i, '.mp4');

        vtLog('VT_saveAssetNative: Preview output path: ' + previewPath);
        vtLog('VT_saveAssetNative: videoSampleItem exists: ' + (videoSampleItem ? 'yes' : 'no'));
        vtLog('VT_saveAssetNative: clipsBefore=' + clipsBefore + ', clipsAfter=' + clipsAfter);

        if (videoSampleItem && clipsAfter > clipsBefore) {
            vtLog('VT_saveAssetNative: Generating preview...');

            try {
                // Get preset path - normalize slashes for Windows
                var presetPath = extPath + '/VT_Preview_480p.epr';
                // Convert forward slashes to backslashes for Windows
                presetPath = presetPath.replace(/\//g, '\\');

                vtLog('VT_saveAssetNative: Extension path: ' + extPath);
                vtLog('VT_saveAssetNative: Preset path: ' + presetPath);

                var presetFile = new File(presetPath);
                vtLog('VT_saveAssetNative: Preset file exists: ' + presetFile.exists);

                if (presetFile.exists) {
                    vtLog('VT_saveAssetNative: Using preset: ' + presetPath);

                    // Calculate duration of pasted clips (on V2+, not V1 which is VideoSample)
                    var maxEndTime = 0;
                    for (var vTrackIdx = 1; vTrackIdx < newSeq.videoTracks.numTracks; vTrackIdx++) {
                        var vTrack = newSeq.videoTracks[vTrackIdx];
                        for (var clipIdx = 0; clipIdx < vTrack.clips.numItems; clipIdx++) {
                            var clip = vTrack.clips[clipIdx];
                            var clipEnd = clip.end.seconds;
                            if (clipEnd > maxEndTime) {
                                maxEndTime = clipEnd;
                            }
                        }
                    }
                    // Also check audio tracks (skip A1 if it's VideoSample audio)
                    for (var aTrackIdx = 1; aTrackIdx < newSeq.audioTracks.numTracks; aTrackIdx++) {
                        var aTrack = newSeq.audioTracks[aTrackIdx];
                        for (var aClipIdx = 0; aClipIdx < aTrack.clips.numItems; aClipIdx++) {
                            var aClip = aTrack.clips[aClipIdx];
                            var aClipEnd = aClip.end.seconds;
                            if (aClipEnd > maxEndTime) {
                                maxEndTime = aClipEnd;
                            }
                        }
                    }

                    vtLog('VT_saveAssetNative: Pasted clips max end time: ' + maxEndTime + 's');

                    // Set In/Out points to match pasted clips duration
                    if (maxEndTime > 0) {
                        newSeq.setInPoint(0); // Start at beginning
                        newSeq.setOutPoint(maxEndTime); // End at last clip
                        vtLog('VT_saveAssetNative: Set In/Out points: 0 to ' + maxEndTime + 's');
                    }

                    // Render preview using IN_TO_OUT (respects In/Out points)
                    vtLog('VT_saveAssetNative: Starting render to: ' + previewPath);
                    vtLog('VT_saveAssetNative: app.encoder available: ' + (typeof app.encoder !== 'undefined'));

                    var renderResult = newSeq.exportAsMediaDirect(previewPath, presetPath, app.encoder.ENCODE_IN_TO_OUT);
                    vtLog('VT_saveAssetNative: Render result: ' + renderResult);

                    // Check if preview was created
                    $.sleep(500); // Give file system time to write
                    var previewFileCheck = new File(previewPath);
                    vtLog('VT_saveAssetNative: Preview file exists after render: ' + previewFileCheck.exists);

                    if (previewFileCheck.exists) {
                        vtLog('VT_saveAssetNative: Preview generated successfully!');
                        previewGenerated = true;
                    } else {
                        vtLog('VT_saveAssetNative: Preview file not found after render');
                    }
                } else {
                    vtLog('VT_saveAssetNative: WARNING - Preset not found: ' + presetPath);
                }
            } catch (renderErr) {
                vtLog('VT_saveAssetNative: Preview render error: ' + renderErr);
            }
        } else {
            vtLog('VT_saveAssetNative: Skipping preview - no VideoSample or no clips pasted');
        }

        // === REMOVE VIDEOSAMPLE FROM V1 AND A1 ===
        // We need to remove it before export so it's not included in .prproj
        if (videoSampleClip) {
            try {
                vtLog('VT_saveAssetNative: Removing VideoSample video from V1...');
                videoSampleClip.remove(false, false);
                vtLog('VT_saveAssetNative: VideoSample video removed');
            } catch (remErr) {
                vtLog('VT_saveAssetNative: Error removing VideoSample video: ' + remErr);
            }
        }

        // Also remove VideoSample audio from A1
        if (videoSampleAudioClip) {
            try {
                vtLog('VT_saveAssetNative: Removing VideoSample audio from A1...');
                videoSampleAudioClip.remove(false, false);
                vtLog('VT_saveAssetNative: VideoSample audio removed');
            } catch (remAudioErr) {
                vtLog('VT_saveAssetNative: Error removing VideoSample audio: ' + remAudioErr);
            }
        }

        // Also remove VideoSample from project bin
        if (videoSampleItem) {
            try {
                videoSampleItem.deleteBin();
                vtLog('VT_saveAssetNative: VideoSample removed from project');
            } catch (delVsErr) {
                vtLog('VT_saveAssetNative: Could not remove VideoSample from project: ' + delVsErr);
            }
        }

        // NORMALIZATION: Move all clips to V1/A1 for correct track targeting on apply
        // IMPORTANT: We must use select+copy+paste to preserve effects!
        // overwriteClip() creates new clips and loses all applied effects!
        vtLog('VT_saveAssetNative: Normalizing clips to V1/A1...');

        // Find the lowest used video track (should be V2 since VideoSample was on V1)
        var lowestVideoTrack = -1;
        for (var vn = 0; vn < newSeq.videoTracks.numTracks; vn++) {
            if (newSeq.videoTracks[vn].clips.numItems > 0) {
                lowestVideoTrack = vn;
                break;
            }
        }

        // Find the lowest used audio track  
        var lowestAudioTrack = -1;
        for (var an = 0; an < newSeq.audioTracks.numTracks; an++) {
            if (newSeq.audioTracks[an].clips.numItems > 0) {
                lowestAudioTrack = an;
                break;
            }
        }

        vtLog('VT_saveAssetNative: Lowest video track = V' + (lowestVideoTrack + 1) + ', audio = A' + (lowestAudioTrack + 1));

        // If clips are not on V1, we need to move them using copy/paste
        if (lowestVideoTrack > 0) {
            vtLog('VT_saveAssetNative: Clips on V' + (lowestVideoTrack + 1) + ', need to move to V1 using copy/paste...');

            // Step 1: Select all clips on sequence
            var allClips = [];
            for (var vSel = 0; vSel < newSeq.videoTracks.numTracks; vSel++) {
                var vTrackSel = newSeq.videoTracks[vSel];
                for (var vClipSel = 0; vClipSel < vTrackSel.clips.numItems; vClipSel++) {
                    allClips.push(vTrackSel.clips[vClipSel]);
                }
            }
            for (var aSel = 0; aSel < newSeq.audioTracks.numTracks; aSel++) {
                var aTrackSel = newSeq.audioTracks[aSel];
                for (var aClipSel = 0; aClipSel < aTrackSel.clips.numItems; aClipSel++) {
                    allClips.push(aTrackSel.clips[aClipSel]);
                }
            }

            vtLog('VT_saveAssetNative: Found ' + allClips.length + ' clips to move');

            if (allClips.length > 0) {
                // Step 2: Select all clips
                try {
                    newSeq.setSelection(allClips);
                    vtLog('VT_saveAssetNative: Selected ' + allClips.length + ' clips');
                } catch (selErr) {
                    vtLog('VT_saveAssetNative: Selection error: ' + selErr);
                }

                // Step 3: Copy
                $.sleep(50);
                var normCopyResult = VT_executeCommand('cmd.edit.copy');
                vtLog('VT_saveAssetNative: Norm copy result: ' + normCopyResult);

                // Step 4: Delete original clips
                for (var delIdx = allClips.length - 1; delIdx >= 0; delIdx--) {
                    try {
                        allClips[delIdx].remove(false, false);
                    } catch (delClipErr) {
                        // Ignore - clip might already be gone
                    }
                }
                vtLog('VT_saveAssetNative: Deleted original clips');

                // Step 5: Set targeting to V1/A1
                VT_setTrackTargeting(newSeq, 0, 0);

                // Step 6: Set playhead to 0
                newSeq.setPlayerPosition('0');

                // Step 7: Paste - clips will land on V1/A1 with effects preserved!
                $.sleep(50);
                var normPasteResult = VT_executeCommand('cmd.edit.paste');
                vtLog('VT_saveAssetNative: Norm paste result: ' + normPasteResult);
                $.sleep(50);
            }
        } else {
            vtLog('VT_saveAssetNative: Clips already on V1, no normalization needed');
        }

        vtLog('VT_saveAssetNative: Normalization complete');

        // Export
        vtLog('VT_saveAssetNative: Exporting...');
        newSeq.exportAsProject(outputPath);

        // Close temp sequence first (removes the tab)
        vtLog('VT_saveAssetNative: Closing temp sequence...');
        try {
            newSeq.close();
        } catch (closeErr) {
            vtLog('VT_saveAssetNative: Close warning: ' + closeErr);
        }

        // Switch back to original sequence
        app.project.openSequence(originalSeqId);
        app.project.activeSequence.setPlayerPosition(originalPlayheadTicks);

        // Wait a bit for sequence switch
        $.sleep(100);

        // Cleanup temp sequence - ExtendScript has no direct sequence-delete, so use the bin workaround
        vtLog('VT_saveAssetNative: Cleaning up temp sequence: ' + tempSeqName);
        try {
            // Find the temp sequence project item
            var tempItem = null;
            for (var k = 0; k < app.project.rootItem.children.numItems; k++) {
                var item = app.project.rootItem.children[k];
                if (item.name === tempSeqName) {
                    tempItem = item;
                    break;
                }
            }

            if (tempItem) {
                // Workaround: create temp bin, move item there, delete bin
                var deleteBin = app.project.rootItem.createBin('_vt_to_delete_');
                // Undo the bin creation from undo stack
                if (typeof qe !== 'undefined' && qe && qe.project) { try { qe.project.undo(); } catch (e) { } }

                tempItem.moveBin(deleteBin);
                deleteBin.deleteBin();
                vtLog('VT_saveAssetNative: Deleted via moveBin workaround');
            } else {
                vtLog('VT_saveAssetNative: Could not find temp sequence to delete');
            }
        } catch (delErr) {
            vtLog('VT_saveAssetNative: Cleanup error: ' + delErr);
        }

        vtLog('VT_saveAssetNative: SUCCESS!');
        return JSON.stringify({
            success: true,
            copyResult: copyResult,
            pasteResult: pasteResult,
            clipsSelected: selection.length,
            clipsBefore: clipsBefore,
            clipsAfter: clipsAfter,
            outputPath: outputPath,
            previewGenerated: previewGenerated,
            previewPath: previewGenerated ? previewPath : null
        });

    } catch (e) {
        vtLog('VT_saveAssetNative error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * Apply asset using native DLL - does everything in one ExtendScript call!
 * No PowerShell, no JS roundtrips
 * @param {string} assetPath - Path to the .prproj asset
 * @returns {string} - 'true' on success, error message on failure
 */
function VT_applyAssetNative(assetPath) {
    try {
        vtLog('VT_applyAssetNative: Starting with ' + assetPath);

        // Ensure DLL is loaded
        if (!VT_initExtObj()) {
            return 'DLL not available';
        }

        // Store reference to current target sequence
        var targetSeq = app.project.activeSequence;
        if (!targetSeq) {
            return 'No active sequence';
        }

        var targetSeqId = targetSeq.sequenceID;
        var targetPlayhead = targetSeq.getPlayerPosition().ticks;
        vtLog('VT_applyAssetNative: Target sequence: ' + targetSeq.name);

        // Check if file exists
        var assetFile = new File(assetPath);
        if (!assetFile.exists) {
            return 'File not found';
        }

        // Track existing sequences
        var existingSeqIds = {};
        for (var s = 0; s < app.project.sequences.numSequences; s++) {
            existingSeqIds[app.project.sequences[s].sequenceID] = true;
        }

        // Import the .prproj file to VibeAssets bin
        vtLog('VT_applyAssetNative: Importing to VibeAssets bin...');
        var assetsBin = VT_getOrCreateAssetsBin();
        app.project.importFiles([assetPath], true, assetsBin, false);

        // Find the imported sequence
        var importedSeq = null;
        var importedSeqItem = null;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var seq = app.project.sequences[i];
            if (!existingSeqIds[seq.sequenceID]) {
                importedSeq = seq;
                importedSeqItem = seq.projectItem;
                break;
            }
        }

        if (!importedSeq) {
            return 'Could not find imported sequence';
        }

        // Open imported sequence
        app.project.openSequence(importedSeq.sequenceID);

        // Select all clips in imported sequence
        var clipsToSelect = [];
        for (var vt = 0; vt < importedSeq.videoTracks.numTracks; vt++) {
            var vTrack = importedSeq.videoTracks[vt];
            for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                clipsToSelect.push(vTrack.clips[vc]);
            }
        }
        for (var at = 0; at < importedSeq.audioTracks.numTracks; at++) {
            var aTrack = importedSeq.audioTracks[at];
            for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
                clipsToSelect.push(aTrack.clips[ac]);
            }
        }

        if (clipsToSelect.length === 0) {
            return 'No clips in imported sequence';
        }

        importedSeq.setSelection(clipsToSelect);
        vtLog('VT_applyAssetNative: Selected ' + clipsToSelect.length + ' clips');

        // COPY using native DLL!
        vtLog('VT_applyAssetNative: Copying...');
        var copyResult = VT_executeCommand('cmd.edit.copy');
        vtLog('VT_applyAssetNative: Copy result = ' + copyResult);

        // Close imported sequence and switch back to target
        try {
            importedSeq.close();
        } catch (e) { }

        app.project.openSequence(targetSeqId);

        // Use QE for faster switch
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try {
                qe.project.getActiveSequence().makeCurrent();
            } catch (e) { }
        }

        // Set playhead
        app.project.activeSequence.setPlayerPosition(targetPlayhead);

        // Snapshot clips BEFORE paste so we can find new ones
        var clipsBefore = {};
        var targetSeqNow = app.project.activeSequence;
        for (var vt2 = 0; vt2 < targetSeqNow.videoTracks.numTracks; vt2++) {
            var vTrack2 = targetSeqNow.videoTracks[vt2];
            for (var vc2 = 0; vc2 < vTrack2.clips.numItems; vc2++) {
                clipsBefore[vTrack2.clips[vc2].nodeId] = true;
            }
        }
        for (var at2 = 0; at2 < targetSeqNow.audioTracks.numTracks; at2++) {
            var aTrack2 = targetSeqNow.audioTracks[at2];
            for (var ac2 = 0; ac2 < aTrack2.clips.numItems; ac2++) {
                clipsBefore[aTrack2.clips[ac2].nodeId] = true;
            }
        }

        // PASTE using native DLL!
        vtLog('VT_applyAssetNative: Pasting...');
        var pasteResult = VT_executeCommand('cmd.edit.paste');
        vtLog('VT_applyAssetNative: Paste result = ' + pasteResult);

        // Find newly pasted clips and select them
        var newClips = [];
        for (var vt3 = 0; vt3 < targetSeqNow.videoTracks.numTracks; vt3++) {
            var vTrack3 = targetSeqNow.videoTracks[vt3];
            for (var vc3 = 0; vc3 < vTrack3.clips.numItems; vc3++) {
                if (!clipsBefore[vTrack3.clips[vc3].nodeId]) {
                    newClips.push(vTrack3.clips[vc3]);
                }
            }
        }
        for (var at3 = 0; at3 < targetSeqNow.audioTracks.numTracks; at3++) {
            var aTrack3 = targetSeqNow.audioTracks[at3];
            for (var ac3 = 0; ac3 < aTrack3.clips.numItems; ac3++) {
                if (!clipsBefore[aTrack3.clips[ac3].nodeId]) {
                    newClips.push(aTrack3.clips[ac3]);
                }
            }
        }

        // Select newly pasted clips
        if (newClips.length > 0) {
            targetSeqNow.setSelection(newClips);
            vtLog('VT_applyAssetNative: Selected ' + newClips.length + ' newly pasted clips');
        }

        // Cleanup - delete imported sequence
        // First try direct delete (works when sequence is closed)
        // If that fails, use moveBin workaround
        try {
            // Try to delete the sequence project item directly
            app.project.deleteSequence(importedSeq);
        } catch (e1) {
            // Fallback to moveBin workaround
            try {
                var delBin = app.project.rootItem.createBin('_vt_delete_');
                if (typeof qe !== 'undefined' && qe && qe.project) {
                    qe.project.undo();
                }
                importedSeqItem.moveBin(delBin);
                delBin.deleteBin();
            } catch (e2) {
                // Last resort - just leave it, user can clean manually
            }
        }

        vtLog('VT_applyAssetNative: SUCCESS!');
        // Return detailed result
        return JSON.stringify({
            success: true,
            copyResult: copyResult,
            pasteResult: pasteResult,
            clipsCount: newClips.length || clipsToSelect.length
        });

    } catch (e) {
        vtLog('VT_applyAssetNative error: ' + e);
        return 'Error: ' + e.toString();
    }
}

/**
 * Apply speed and reverse to currently selected clips via QE DOM
 */
function VT_applySpeedToSelectedClips(speed, reverse) {
    try {
        app.enableQE();
        var seq = app.project.activeSequence;
        if (!seq) return false;
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return false;

        function getQEClipMatch(qeTrack, targetClipIndex) {
            var curIndex = -1;
            for (var i = 0; i < qeTrack.numItems; i++) {
                var item = qeTrack.getItemAt(i);
                if (item.type === 'Empty') continue;
                curIndex++;
                if (curIndex === targetClipIndex) return item;
            }
            return null;
        }

        var changed = 0;

        // Video Tracks
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            var qeTrack = qeSeq.getVideoTrackAt(t);
            if (!qeTrack) continue;

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.isSelected()) {
                    var qeClip = getQEClipMatch(qeTrack, c);
                    if (qeClip) {
                        qeClip.setSpeed(speed, '', reverse, false, false);
                        if (speed != 1) {
                            qeClip.setSpeed(speed, '00;30;00;00', reverse, false, false);
                        }
                        changed++;
                    }
                }
            }
        }

        // Audio Tracks
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            var qeTrack = qeSeq.getAudioTrackAt(t);
            if (!qeTrack) continue;

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.isSelected()) {
                    var qeClip = getQEClipMatch(qeTrack, c);
                    if (qeClip) {
                        // QE setSpeed quirk: first call with empty timecode,
                        // then second call with timecode if speed != 1
                        qeClip.setSpeed(speed, '', reverse, false, false);
                        if (speed != 1) {
                            qeClip.setSpeed(speed, '00;30;00;00', reverse, false, false);
                        }
                        changed++;
                    }
                }
            }
        }

        vtLog('VT_applySpeedToSelectedClips: Applied to ' + changed + ' clips.');
        return changed > 0;
    } catch(e) {
        vtLog('VT_applySpeedToSelectedClips error: ' + e);
        return false;
    }
}

/**
 * Safe wrapper for VT_applyAssetNative - bypasses bytecode cache
 */
function VT_applyAssetNative_Safe(assetPath, optionsString) {
    vtLog('VT_applyAssetNative_Safe: START');

    // Parse options
    var opts = { speed: 1.0, reverse: false };
    if (optionsString) {
        try { opts = JSON.parse(optionsString); } catch(e){}
    }

    // PRE-CHECK: Verify DLL is still loaded
    try {
        if (!$.global.VT_ExtObj) {
            vtLog('VT_applyAssetNative_Safe: DLL not loaded, reinitializing...');
            VT_initExtObj();
        }
    } catch (dllErr) {
        vtLog('VT_applyAssetNative_Safe: DLL check error: ' + dllErr);
    }

    // Call main function with try/catch isolation
    try {
        vtLog('VT_applyAssetNative_Safe: Calling main function...');
        var result = VT_applyAssetNative(assetPath);
        vtLog('VT_applyAssetNative_Safe: Main function returned: ' + result);
        
        // Apply speed/reverse if needed and successful
        if ((opts.speed !== 1.0 || opts.reverse) && result.indexOf('success') !== -1) {
            vtLog('VT_applyAssetNative_Safe: Applying speed=' + opts.speed + ', reverse=' + opts.reverse);
            VT_applySpeedToSelectedClips(opts.speed, opts.reverse);
        }
        
        return result;
    } catch (mainErr) {
        vtLog('VT_applyAssetNative_Safe: MAIN FUNCTION CRASHED: ' + mainErr);
        return JSON.stringify({
            success: false,
            error: 'Main function crash: ' + mainErr.toString(),
            line: mainErr.line || 'unknown'
        });
    }
}

/**
 * Test DLL command execution
 * @returns {string} - JSON with test results
 */
function VT_testDllCommand() {
    var result = {
        dllLoaded: false,
        testCommand: false,
        error: null
    };

    try {
        // Check if DLL is loaded
        result.dllLoaded = VT_initExtObj();

        if (result.dllLoaded) {
            // Try a harmless command
            var cmdResult = VT_executeCommand('cmd.edit.selectNone');
            result.testCommand = (cmdResult === true || cmdResult === 'true');
        }
    } catch (e) {
        result.error = e.toString();
    }

    return JSON.stringify(result);
}

/**
 * Insert a MOGRT (Motion Graphics Template) at playhead position
 * @param {string} mogrtPath - Full path to the .mogrt file
 * @returns {string} - JSON result
 */
function VT_insertMogrt(mogrtPath) {
    try {
        vtLog('VT_insertMogrt: Starting with ' + mogrtPath);

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        // Get playhead position
        var playheadTicks = seq.getPlayerPosition().ticks;

        // Get first targeted video track
        var targetTrack = 0;
        for (var i = 0; i < seq.videoTracks.numTracks; i++) {
            if (seq.videoTracks[i].isTargeted()) {
                targetTrack = i;
                break;
            }
        }

        // Use sequence.importMGT API
        var mgResult = seq.importMGT(
            mogrtPath,           // path to MOGRT
            playheadTicks,       // time (as ticks string)
            targetTrack,         // video track index
            targetTrack          // audio track index
        );

        vtLog('VT_insertMogrt: importMGT result = ' + mgResult);

        return JSON.stringify({
            success: (mgResult !== null && mgResult !== undefined),
            track: targetTrack,
            position: seq.getPlayerPosition().seconds
        });

    } catch (e) {
        vtLog('VT_insertMogrt error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * Insert a MOGRT at a specific placeholder position (for drag & drop)
 * Removes the placeholder .vtbk clip first, then inserts MOGRT at its position
 * @param {string} mogrtPath - Full path to the .mogrt file
 * @param {object} placeholderInfo - { trackIndex, clipIndex, startTicks, startSeconds }
 * @returns {string} - JSON result
 */
function VT_insertMogrtAtPosition(mogrtPath, placeholderInfo) {
    try {
        vtLog('VT_insertMogrtAtPosition: Starting with ' + mogrtPath);

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        var targetTrack = parseInt(placeholderInfo.trackIndex, 10) || 0;
        var startTicks = placeholderInfo.startTicks;

        // Remove placeholder .vtbk clip
        try {
            if (placeholderInfo.isVideo !== false) {
                var vtrack = seq.videoTracks[targetTrack];
                if (vtrack && vtrack.clips.numItems > (placeholderInfo.clipIndex || 0)) {
                    var clip = vtrack.clips[(placeholderInfo.clipIndex || 0)];
                    if (clip && clip.name && (clip.name.match(/\.vtbk$/i) || clip.name.match(/vt_drag_\d+/i))) {
                        clip.remove(false, false);
                        vtLog('VT_insertMogrtAtPosition: Removed placeholder');
                    }
                }
            }
        } catch (removeErr) {
            vtLog('VT_insertMogrtAtPosition: Placeholder remove failed: ' + removeErr);
        }

        // Set track targeting
        for (var i = 0; i < seq.videoTracks.numTracks; i++) {
            seq.videoTracks[i].setTargeted(i === targetTrack, true);
        }

        // Set playhead to placeholder position
        try {
            seq.setPlayerPosition(startTicks);
        } catch (tickErr) {
            var t = new Time();
            t.seconds = placeholderInfo.startSeconds || 0;
            seq.setPlayerPosition(t.ticks);
        }

        // Insert MOGRT
        vtLog('VT_insertMogrtAtPosition: Inserting at track=' + targetTrack + ' ticks=' + startTicks);
        var mgResult = seq.importMGT(
            mogrtPath,
            startTicks,
            targetTrack,
            targetTrack
        );

        vtLog('VT_insertMogrtAtPosition: importMGT result = ' + mgResult);

        return JSON.stringify({
            success: (mgResult !== null && mgResult !== undefined),
            track: targetTrack,
            position: placeholderInfo.startSeconds
        });

    } catch (e) {
        vtLog('VT_insertMogrtAtPosition error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * Insert an external media file (video, audio, image) at playhead position
 * @param {string} filePath - Full path to the media file
 * @param {object} placeholderInfoStr - Optional info about placeholder position
 * @returns {string} - JSON result
 */
function VT_insertExternalFile(filePath, placeholderInfo, optionsString) {
    try {
        vtLog('VT_insertExternalFile: Starting with ' + filePath);

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        // Check if it's audio or video
        var isAudioFile = filePath.match(/\.(mp3|wav|ogg|aac|m4a|flac|aiff)$/i);

        // Parse options for Speed/Reverse (before we need them)
        var options = { speed: 1.0, reverse: false };
        if (optionsString) {
            try {
                if (typeof optionsString === 'string') {
                    optionsString = optionsString.replace(/([{,]\s*)(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '$1"$3":');
                    options = eval('(' + optionsString + ')');
                } else {
                    options = optionsString;
                }
            } catch (e) {
                vtLog('VT_insertExternalFile: Failed to parse options: ' + e);
            }
        }

        // Placeholder path (drag & drop)
        if (placeholderInfo && placeholderInfo.startTicks) {
            var targetTrackIndex = parseInt(placeholderInfo.trackIndex, 10) || 0;
            var insertTicks = placeholderInfo.startTicks;
            var clipIndex = parseInt(placeholderInfo.clipIndex, 10) || 0;

            var insertTime = null;
            var linkedAudioTrack = targetTrackIndex;
            var linkedAudioTime = null;
            var isPlaceholderVideo = (placeholderInfo.isVideo !== false); // Default true if missing

            var targetTrack = isPlaceholderVideo ? seq.videoTracks[targetTrackIndex] : seq.audioTracks[targetTrackIndex];

            if (targetTrack && targetTrack.clips.numItems > clipIndex) {
                var pclip = targetTrack.clips[clipIndex];
                if (pclip && pclip.name && (pclip.name.match(/\.vtbk$/i) || pclip.name.match(/vt_drag_\d+/i))) {
                    insertTime = pclip.start;

                    // For audio files with video placeholders: find the placeholder's linked audio to get audio track index
                    if (isPlaceholderVideo && isAudioFile) {
                        try {
                            var linkedItems = pclip.getLinkedItems();
                            if (linkedItems) {
                                for (var li = 0; li < linkedItems.length; li++) {
                                    for (var at = 0; at < seq.audioTracks.numTracks; at++) {
                                        var atrk = seq.audioTracks[at];
                                        for (var ac = 0; ac < atrk.clips.numItems; ac++) {
                                            if (atrk.clips[ac].nodeId === linkedItems[li].nodeId) {
                                                linkedAudioTrack = at;
                                                linkedAudioTime = atrk.clips[ac].start;
                                                vtLog('VT_insertExternalFile: Linked audio on A' + (at + 1));
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (linkErr) { vtLog('Linked audio search failed: ' + linkErr); }
                    } else if (!isPlaceholderVideo && isAudioFile) {
                        // The placeholder is already on the audio track
                        linkedAudioTrack = targetTrackIndex;
                        linkedAudioTime = insertTime;
                    }

                    pclip.remove(false, false);
                    vtLog('VT_insertExternalFile: Removed placeholder at ' + (isPlaceholderVideo ? 'V' : 'A') + (targetTrackIndex + 1));
                }
            }

            if (!insertTime) {
                vtLog('VT_insertExternalFile: Placeholder not found, using ticks position');
                var ti = new Time();
                ti.ticks = insertTicks;
                insertTime = ti;
            }

            // Import file
            var assetsBin = VT_getOrCreateAssetsBin();
            app.project.importFiles([filePath], true, assetsBin, false);

            // Find the imported item
            var importedItem = null;
            for (var i = assetsBin.children.numItems - 1; i >= 0; i--) {
                var child = assetsBin.children[i];
                var fileName = filePath.replace(/^.*[\\\/]/, '');
                if (child.name === fileName || child.name.indexOf(fileName.replace(/\.[^.]+$/, '')) !== -1) {
                    importedItem = child;
                    break;
                }
            }

            if (!importedItem) {
                return JSON.stringify({ success: false, error: 'Could not find imported file in project' });
            }

            // Snapshot all existing clips, then overwriteClip, then diff for the new clip
            var existingNodeIds = {};
            for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
                for (var sc = 0; sc < seq.videoTracks[sv].clips.numItems; sc++) {
                    existingNodeIds[seq.videoTracks[sv].clips[sc].nodeId] = true;
                }
            }
            for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
                for (var sc = 0; sc < seq.audioTracks[sa].clips.numItems; sc++) {
                    existingNodeIds[seq.audioTracks[sa].clips[sc].nodeId] = true;
                }
            }

            if (isAudioFile) {
                var audTime = linkedAudioTime || insertTime;
                seq.overwriteClip(importedItem, audTime, 0, linkedAudioTrack);
                vtLog('VT_insertExternalFile: overwriteClip audio at A' + (linkedAudioTrack + 1));
            } else {
                seq.overwriteClip(importedItem, insertTime, targetTrackIndex, 0);
                vtLog('VT_insertExternalFile: overwriteClip video at V' + (targetTrackIndex + 1));
            }

            // Find the newly added clip by nodeId diff
            var insertedClip = null;
            for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
                for (var sc = 0; sc < seq.audioTracks[sa].clips.numItems; sc++) {
                    var c = seq.audioTracks[sa].clips[sc];
                    if (!existingNodeIds[c.nodeId]) {
                        insertedClip = c;
                        break;
                    }
                }
                if (insertedClip) break;
            }
            if (!insertedClip) {
                for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
                    for (var sc = 0; sc < seq.videoTracks[sv].clips.numItems; sc++) {
                        var c = seq.videoTracks[sv].clips[sc];
                        if (!existingNodeIds[c.nodeId]) {
                            insertedClip = c;
                            break;
                        }
                    }
                    if (insertedClip) break;
                }
            }

            if (insertedClip) {
                insertedClip.setSelected(true, true);
                vtLog('VT_insertExternalFile: Found new clip via nodeId diff');
            } else {
                vtLog('VT_insertExternalFile: WARNING - could not find new clip after overwriteClip');
            }

            // Apply speed via direct QE
            if (!isAudioFile && (options.speed !== 1.0 || options.reverse) && insertedClip) {
                $.sleep(80);
                vtLog('VT_insertExternalFile: Direct QE speed=' + options.speed + ' reverse=' + options.reverse);
                try {
                    app.enableQE();
                    var qeSeq = qe.project.getActiveSequence();
                    if (qeSeq) {
                        var targetTicks = insertedClip.start.ticks;
                        if (isAudioFile) {
                            for (var qat = 0; qat < qeSeq.numAudioTracks; qat++) {
                                var qet = qeSeq.getAudioTrackAt(qat);
                                for (var qi = 0; qi < qet.numItems; qi++) {
                                    var qeItem = qet.getItemAt(qi);
                                    if (!qeItem || qeItem.type === 'Empty') continue;
                                    var qeStartTicks = qeItem.start.ticks || qeItem.start || 0;
                                    var diff = Math.abs(parseInt(String(qeStartTicks), 10) - parseInt(String(targetTicks), 10));
                                    if (diff < 100) {
                                        qeItem.setSpeed(options.speed, '', options.reverse, false, false);
                                        if (options.speed != 1) {
                                            qeItem.setSpeed(options.speed, '00;30;00;00', options.reverse, false, false);
                                        }
                                        vtLog('VT_insertExternalFile: Speed applied OK');
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch (qeErr) {
                    vtLog('VT_insertExternalFile: QE speed failed: ' + qeErr);
                }
            }

            return JSON.stringify({ success: true, clipsCount: insertedClip ? 1 : 0 });
        }

        // No placeholder (double-click / applyAsset path)

        var insertTicks = seq.getPlayerPosition().ticks;
        var targetTrackIndex = 0;

        // Deselect all clips first
        try {
            var selection = seq.getSelection();
            if (selection && selection.length > 0) {
                for (var si = 0; si < selection.length; si++) {
                    selection[si].setSelected(false, true);
                }
            }
        } catch (dsErr) { vtLog('Deselect warning: ' + dsErr); }

        // Import file to project
        var assetsBin = VT_getOrCreateAssetsBin();
        app.project.importFiles([filePath], true, assetsBin, false);

        var importedItem = null;
        for (var i = assetsBin.children.numItems - 1; i >= 0; i--) {
            var child = assetsBin.children[i];
            var fileName = filePath.replace(/^.*[\\\/]/, '');
            if (child.name === fileName || child.name.indexOf(fileName.replace(/\.[^.]+$/, '')) !== -1) {
                importedItem = child;
                break;
            }
        }

        if (!importedItem) {
            return JSON.stringify({ success: false, error: 'Could not find imported file in project' });
        }

        // Snapshot + insertClip
        var existingNodeIds = {};
        for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
            for (var sc = 0; sc < seq.videoTracks[sv].clips.numItems; sc++) {
                existingNodeIds[seq.videoTracks[sv].clips[sc].nodeId] = true;
            }
        }
        for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
            for (var sc = 0; sc < seq.audioTracks[sa].clips.numItems; sc++) {
                existingNodeIds[seq.audioTracks[sa].clips[sc].nodeId] = true;
            }
        }

        if (isAudioFile) {
            var audioTrack = seq.audioTracks[targetTrackIndex];
            if (audioTrack) {
                audioTrack.insertClip(importedItem, insertTicks);
            }
        } else {
            var videoTrack = seq.videoTracks[targetTrackIndex];
            if (videoTrack) {
                videoTrack.insertClip(importedItem, insertTicks);
            }
        }

        // Find new clip by nodeId diff
        var insertedClip = null;
        for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
            for (var sc = 0; sc < seq.audioTracks[sa].clips.numItems; sc++) {
                var c = seq.audioTracks[sa].clips[sc];
                if (!existingNodeIds[c.nodeId]) {
                    insertedClip = c;
                    break;
                }
            }
            if (insertedClip) break;
        }
        if (!insertedClip) {
            for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
                for (var sc = 0; sc < seq.videoTracks[sv].clips.numItems; sc++) {
                    var c = seq.videoTracks[sv].clips[sc];
                    if (!existingNodeIds[c.nodeId]) {
                        insertedClip = c;
                        break;
                    }
                }
                if (insertedClip) break;
            }
        }

        if (insertedClip) {
            insertedClip.setSelected(true, true);
            vtLog('VT_insertExternalFile: Found new clip via nodeId diff');
        }

        // Apply speed via direct QE
        if (!isAudioFile && insertedClip && (options.speed !== 1.0 || options.reverse)) {
            $.sleep(80);
            vtLog('VT_insertExternalFile: Direct QE speed=' + options.speed + ' reverse=' + options.reverse);
            try {
                app.enableQE();
                var qeSeq = qe.project.getActiveSequence();
                if (qeSeq) {
                    var targetTicks = insertedClip.start.ticks;
                    if (isAudioFile) {
                        for (var qat = 0; qat < qeSeq.numAudioTracks; qat++) {
                            var qet = qeSeq.getAudioTrackAt(qat);
                            for (var qi = 0; qi < qet.numItems; qi++) {
                                var qeItem = qet.getItemAt(qi);
                                if (!qeItem || qeItem.type === 'Empty') continue;
                                var qeStartTicks = qeItem.start.ticks || qeItem.start || 0;
                                var diff = Math.abs(parseInt(String(qeStartTicks), 10) - parseInt(String(targetTicks), 10));
                                if (diff < 100) {
                                    qeItem.setSpeed(options.speed, '', options.reverse, false, false);
                                    if (options.speed != 1) {
                                        qeItem.setSpeed(options.speed, '00;30;00;00', options.reverse, false, false);
                                    }
                                    vtLog('VT_insertExternalFile: Speed applied OK');
                                    break;
                                }
                            }
                        }
                    } else {
                        for (var qvt = 0; qvt < qeSeq.numVideoTracks; qvt++) {
                            var qet = qeSeq.getVideoTrackAt(qvt);
                            for (var qi = 0; qi < qet.numItems; qi++) {
                                var qeItem = qet.getItemAt(qi);
                                if (!qeItem || qeItem.type === 'Empty') continue;
                                var qeStartTicks = qeItem.start.ticks || qeItem.start || 0;
                                var diff = Math.abs(parseInt(String(qeStartTicks), 10) - parseInt(String(targetTicks), 10));
                                if (diff < 100) {
                                    qeItem.setSpeed(options.speed, '', options.reverse, false, false);
                                    if (options.speed != 1) {
                                        qeItem.setSpeed(options.speed, '00;30;00;00', options.reverse, false, false);
                                    }
                                    vtLog('VT_insertExternalFile: Speed applied OK');
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (qeErr) {
                vtLog('VT_insertExternalFile: QE speed failed: ' + qeErr);
                try { VT_applySpeedToSelectedClips(options.speed, options.reverse); } catch (e2) {}
            }
        } else if (!isAudioFile && !insertedClip && (options.speed !== 1.0 || options.reverse)) {
            vtLog('VT_insertExternalFile: No insertedClip, speed fallback');
            $.sleep(80);
            try { VT_applySpeedToSelectedClips(options.speed, options.reverse); } catch (e2) {}
        }

        return JSON.stringify({ success: true, clipsCount: insertedClip ? 1 : 0 });

    } catch (e) {
        vtLog('VT_insertExternalFile error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function VT_readDebugLog() {
    try {
        var logFile = Folder.temp + '/vibetool_debug.txt';
        var f = new File(logFile);
        if (!f.exists) return JSON.stringify({ lines: [], msg: 'no log file' });
        f.open('r');
        var content = f.read();
        f.close();
        var lines = content.split('\n');
        var last = lines.slice(Math.max(0, lines.length - 21), lines.length);
        return JSON.stringify({ lines: last, total: lines.length });
    } catch (e) {
        return JSON.stringify({ lines: ['ERROR: ' + e], total: 0 });
    }
}

function VT_clearDebugLog() {
    try {
        var logFile = Folder.temp + '/vibetool_debug.txt';
        var f = new File(logFile);
        f.open('w');
        f.write('');
        f.close();
        return 'cleared';
    } catch (e) {
        return 'error: ' + e;
    }
}
