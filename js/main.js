/**
 * VibeTools - Main JavaScript
 * Handles UI logic, drag & drop, and communication with ExtendScript
 */

import { addLog } from './log.js';
import { AudioPreview, generateWaveform, setupStaticWaveform } from './audioPreview.js';

// Node.js modules (available in CEP)
const fs = window.require('fs');
const path = window.require('path');
const os = window.require('os');
const { exec } = window.require('child_process');

// Get extension directory for proper require paths (decode URL encoding)
const extensionDir = decodeURIComponent(path.dirname(window.location.pathname.replace(/^\//, '')));

// CEP Interface
const csInterface = new CSInterface();

// Asset storage path
const ASSETS_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'VibeTools', 'assets');

// UI Elements
const assetGrid = document.getElementById('assetGrid');

const emptyState = document.getElementById('emptyState');
const saveAssetBtn = document.getElementById('saveAssetBtn');
const saveDialog = document.getElementById('saveDialog');
const assetNameInput = document.getElementById('assetName');
const cancelSaveBtn = document.getElementById('cancelSave');
const confirmSaveBtn = document.getElementById('confirmSave');
const statusText = document.getElementById('statusText');
const debugLog = document.getElementById('debugLog');
const clearLogBtn = document.getElementById('clearLog');
const testCmdsBtn = document.getElementById('testCmds');
const reloadScriptsBtn = document.getElementById('reloadScripts');
const scriptVersionEl = document.getElementById('scriptVersion');
const assetTypeSelect = document.getElementById('assetType');
const categorySidebar = document.getElementById('categorySidebar');

// Asset list
let assets = [];

// Category state
let selectedCategory = 'all';
let searchFilter = ''; // Search filter text
let recentAssets = JSON.parse(localStorage.getItem('vt_recent_assets') || '[]');
const MAX_RECENT = 10;

// Context menu state
let contextMenuAsset = null;
const contextMenu = document.getElementById('contextMenu');
const previewPicker = document.getElementById('previewPicker');

// Multi-select state
let selectedAssetIds = new Set();
let lastSelectedAssetId = null;

// Dropdown and import state
const saveDropdownMenu = document.getElementById('saveDropdownMenu');
const saveDropdownToggle = document.getElementById('saveDropdownToggle');
const importPicker = document.getElementById('importPicker');
let pendingImportFile = null; // File path waiting for category selection

// Temp directory for .vtbk files
const VTBK_TEMP_DIR = path.join(os.tmpdir(), 'VibeTools');

// Permanent folder for audio that was dropped with pitch/reverse applied. The
// processed render is otherwise temporary, and Premiere keeps referencing the
// dropped clip's source file - storing it here (not %TEMP%) avoids "missing media".
const DROPPED_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'VibeTools', 'dropped');

// Event pausing - blocks evalScript calls during critical drag-drop operations
window._vtBusy = false;
function setVtBusy(busy) {
    window._vtBusy = busy;
    if (busy) {
        addLog('VT_BUSY: ON - blocking evalScript', 'info');
    } else {
        addLog('VT_BUSY: OFF', 'info');
    }
}
function isVtBusy() { return window._vtBusy; }

/**
 * Play a beep sound for notifications
 * @param {number} frequency - Frequency in Hz (default 440 = A4)
 * @param {number} duration - Duration in ms (default 150)
 * @param {string} type - 'start' or 'success'
 */
function playBeep(type = 'start') {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        if (type === 'start') {
            // Warning beep - two quick low tones
            oscillator.frequency.value = 440;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.3;
            oscillator.start();
            oscillator.stop(ctx.currentTime + 0.1);
        } else if (type === 'success') {
            // Success beep - ascending two-tone
            oscillator.frequency.value = 523; // C5
            oscillator.type = 'sine';
            gainNode.gain.value = 0.3;
            oscillator.start();
            oscillator.frequency.setValueAtTime(659, ctx.currentTime + 0.1); // E5
            oscillator.stop(ctx.currentTime + 0.2);
        } else if (type === 'error') {
            // Error beep - low descending
            oscillator.frequency.value = 300;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.3;
            oscillator.start();
            oscillator.frequency.setValueAtTime(200, ctx.currentTime + 0.15);
            oscillator.stop(ctx.currentTime + 0.3);
        }
    } catch (e) {
        // Ignore audio errors
    }
}

/**
 * Get preview file path for an asset (same name but .mp4 extension)
 */
function getPreviewPath(assetPath) {
    // Replace any extension with .mp4 (auto-generated by VT_saveAssetNative)
    return assetPath.replace(/\.[^.]+$/, '.mp4');
}

/**
 * Check if file is an audio file by extension
 */
function isAudioFile(filePath) {
    return /\.(mp3|wav|ogg|aac|m4a|flac|aiff)$/i.test(filePath);
}

/**
 * Check if file is a MOGRT file by extension
 */
function isMogrtFile(filePath) {
    return /\.mogrt$/i.test(filePath);
}

/**
 * Check if asset is video-based (for timeline placement)
 */
function isVideoAsset(asset) {
    // If it's external, check the file extension
    if (asset.isExternal) {
        return !isAudioFile(asset.path);
    }
    // For .prproj assets, check the type field
    return asset.type !== 'audio';
}

/**
 * Check if preview exists for asset (only for video assets, not audio/mogrt)
 */
const previewCache = new Map();

function hasPreview(asset) {
    // Audio files and MOGRT files don't have video preview
    if (asset.isExternal && isAudioFile(asset.path)) {
        return false;
    }
    if (isMogrtFile(asset.path)) {
        return false;
    }

    const key = asset.id || asset.path;
    if (previewCache.has(key)) return previewCache.get(key);

    const previewPath = getPreviewPath(asset.path);
    const exists = fs.existsSync(previewPath);
    previewCache.set(key, exists);
    return exists;
}

function invalidatePreviewCache(assetId) {
    previewCache.delete(assetId);
}

/**
 * In-memory favorites cache avoids repeated localStorage reads
 */
let favoritesCache = null;

function getFavoritesSet() {
    if (favoritesCache === null) {
        favoritesCache = new Set(JSON.parse(localStorage.getItem('vt_favorites') || '[]'));
    }
    return favoritesCache;
}

function invalidateFavoritesCache() {
    favoritesCache = null;
}

/**
 * Audio context for waveform generation
 */

/**
 * Create a .vtbk file for drag & drop
 * This creates a native Premiere importer file that will be used as placeholder
 * @param {object} asset - The asset being dragged
 * @returns {string|null} Path to created .vtbk file, or null on error
 */
function createVtbkFile(asset) {
    try {
        // Ensure temp directory exists
        if (!fs.existsSync(VTBK_TEMP_DIR)) {
            fs.mkdirSync(VTBK_TEMP_DIR, { recursive: true });
        }
        // Audio: drop a vt_drag_* placeholder file. The name lets VT_findPlaceholder
        // locate the dropped clip after dragend, so replacePlaceholderWithAsset can
        // swap it for the (pitched, once ffmpeg finishes) audio at the drop position.
        // Stored in DROPPED_DIR (permanent), so even if the swap doesn't run it never
        // becomes "missing media" (unlike the old %TEMP% copy that got cleaned up).
        if (isAudioFile(asset.path)) {
            let srcPath = asset.path;
            if (typeof AudioPreview !== 'undefined' && AudioPreview.asset &&
                AudioPreview.asset.id === asset.id && AudioPreview.processedAudioPath) {
                srcPath = AudioPreview.processedAudioPath;
            }
            if (!fs.existsSync(DROPPED_DIR)) fs.mkdirSync(DROPPED_DIR, { recursive: true });
            const ext = path.extname(srcPath);
            const placeholderPath = path.join(DROPPED_DIR, 'vt_drag_' + Date.now() + ext);
            fs.copyFileSync(srcPath, placeholderPath);
            return placeholderPath;
        }

        // Read asset metadata to get duration info
        let frameRate = 30000;
        let frameRateDivisor = 1001;
        let frameCount = 30;
        let hasVideo = true;
        let hasAudio = true;

        // Try to read from asset metadata
        if (asset.metadata) {
            if (asset.metadata.frameRate) frameRate = asset.metadata.frameRate;
            if (asset.metadata.frameRateDivisor) frameRateDivisor = asset.metadata.frameRateDivisor;
            if (asset.metadata.frameCount) frameCount = asset.metadata.frameCount;
            if (asset.metadata.hasVideo !== undefined) hasVideo = asset.metadata.hasVideo;
            if (asset.metadata.hasAudio !== undefined) hasAudio = asset.metadata.hasAudio;
        }

        if (isAudioFile(asset.path)) {
            hasVideo = false;
        }

        // Create .vtbk content (JSON format)
        const vtbkContent = {
            streams: [{
                hasVideo: hasVideo,
                hasAudio: hasAudio,
                videoFrameRate: frameRate,
                videoFrameRateDivisor: frameRateDivisor,
                videoFrameCount: frameCount
            }],
            _vtAssetId: asset.id || 1,
            _vtAssetName: asset.name || 'VT Asset',
            _vtAssetPath: asset.path || ''
        };

        // Write to temp file
        const vtbkPath = path.join(VTBK_TEMP_DIR, 'vt_drag_' + Date.now() + '.vtbk');
        fs.writeFileSync(vtbkPath, JSON.stringify(vtbkContent), 'utf8');

        return vtbkPath;
    } catch (e) {
        console.error('Error creating .vtbk file:', e);
        return null;
    }
}

/**
 * Initialize Settings Module
 */
function initSettings() {
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsDialog = document.getElementById('settingsDialog');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const settingDebugPanel = document.getElementById('settingDebugPanel');
    const debugPanel = document.getElementById('debugPanel');

    // Functions
    function openSettings() {
        if (settingsDialog) {
            settingsDialog.style.display = 'flex';
            // Slight delay for animation if needed
            requestAnimationFrame(() => {
                settingsDialog.classList.add('open');
            });
        }
    }

    function closeSettings() {
        if (settingsDialog) {
            settingsDialog.classList.remove('open');
            setTimeout(() => {
                settingsDialog.style.display = 'none';
            }, 200); // match transition
        }
    }

    function toggleDebugVisibility(show) {
        if (debugPanel) {
            if (show) {
                debugPanel.style.display = 'flex';
            } else {
                debugPanel.style.display = 'none';
            }
        }
        localStorage.setItem('vt_show_debug', show);
    }

    // Initialize state
    const showDebug = localStorage.getItem('vt_show_debug') !== 'false';
    if (settingDebugPanel) {
        settingDebugPanel.checked = showDebug;
        toggleDebugVisibility(showDebug);
    }

    // Event Listeners
    // Use document delegation for settingsBtn since it might be recreated by switchModule
    document.addEventListener('click', function (e) {
        const btn = e.target.closest('#settingsBtn');
        if (btn) {
            openSettings();
        }
    });

    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', closeSettings);
    }

    if (settingsDialog) {
        settingsDialog.addEventListener('click', function (e) {
            if (e.target === settingsDialog) closeSettings();
        });
    }

    if (settingDebugPanel) {
        settingDebugPanel.addEventListener('change', function () {
            toggleDebugVisibility(this.checked);
        });
    }
}

/**
 * Initialize the panel
 */
function init() {

    // Ensure assets directory exists
    ensureAssetsDir();

    // Clean up temporary files
    cleanupTempFiles();

    // Load existing assets
    loadAssets();

    // Setup event listeners
    setupEventListeners();
    setupEventListenersContinued();
    initSettings(); // Initialize Settings Module

    // Restore active module state (triggers toolbar setup)
    setTimeout(() => {
        const activeModule = localStorage.getItem('vt_active_module') || 'assets';
        const tab = document.querySelector(`.module-tab[data-module="${activeModule}"]`);
        if (tab) {
            tab.click();
        }
    }, 50);

    // Warm-up ExtendScript to prevent first-call crash after Premiere restart
    warmUpExtendScript();

    // Initialize Audio Preview Bar
    if (AudioPreview) AudioPreview.init();

    setStatus('Ready');
}

/**
 * Warm-up ExtendScript engine to prevent first-call crash
 * This forces initialization of DLL and all dependencies before first real use
 * Includes auto-retry logic with delays in case Premiere isn't fully ready
 * 
 * IMPORTANT: When Premiere starts with the panel already open (from previous session),
 * the ExtendScript engine may not be fully initialized. We need to wait longer
 * and verify $.global is accessible before attempting to use DLL.
 */
async function warmUpExtendScript() {
    addLog('Warming up ExtendScript...', 'info');

    const scriptPath = extensionDir + '/jsx/hostscript.jsx';
    const maxRetries = 5;  // Increased from 3 to handle startup race condition
    const delays = [1000, 1500, 2000, 3000, 5000]; // Longer delays, especially first one

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // CRITICAL: Wait longer on first attempt to let Premiere/ExtendScript fully initialize
            // This is especially important when panel was open when Premiere was closed
            // and auto-loads on next Premiere start
            if (attempt === 0) {
                addLog('Waiting for ExtendScript engine to initialize...', 'info');
                await new Promise(resolve => setTimeout(resolve, 1500)); // Increased from 300ms to 1.5s
            }

            // 1. Force script load
            const loadResult = await evalScriptAsync('$.evalFile("' + scriptPath.replace(/\\/g, '/') + '")');

            // Check if load actually worked by testing a simple function
            const versionCheck = await evalScriptAsync('VT_getVersion()');

            if (versionCheck && versionCheck.indexOf('EvalScript error') === -1) {
                // Script loaded successfully! Parse the version
                try {
                    const vData = JSON.parse(versionCheck);
                    addLog('ExtendScript version: ' + vData.version);
                } catch (e) {
                    addLog('ExtendScript loaded (version parse failed)');
                }
            } else {
                throw new Error('Script load returned error: ' + versionCheck);
            }

            // 2. CRITICAL: Check that $.global is accessible (may fail on cold start)
            addLog('Checking $.global accessibility...');
            const globalCheck = await evalScriptAsync('typeof $.global');
            if (globalCheck === 'undefined' || globalCheck.indexOf('EvalScript error') !== -1) {
                throw new Error('$.global not ready yet: ' + globalCheck);
            }
            addLog('$.global accessible: ' + globalCheck);

            // 3. Test DLL path first
            const dllPathTest = await evalScriptAsync('VT_testDllPath()');
            addLog('DLL path test: ' + dllPathTest);

            // 4. Initialize DLL  
            const dllResult = await evalScriptAsync('VT_initExtObj()');
            addLog('DLL init: ' + dllResult);

            // 5. If DLL failed, force clear $.global.VT_ExtObj and retry
            if (dllResult !== 'true') {
                addLog('DLL init failed, trying force reload...', 'info');
                // Force clear and retry - use try/catch wrapper to handle $.global issues
                await evalScriptAsync('try { $.global.VT_ExtObj = null; } catch(e) { }');
                const retryResult = await evalScriptAsync('VT_initExtObj()');
                addLog('DLL init retry: ' + retryResult);
            }

            // 5. Warmup: force-compile critical paths (JSON, Time, sequence access, DLL)
            // This ensures all code paths are JIT-compiled before first real use
            addLog('Warming up critical paths...');
            const criticalPathsResult = await evalScriptAsync('VT_warmupCriticalPaths()');
            addLog('Critical paths warmup: ' + criticalPathsResult);

            // Success! Exit the retry loop
            return;

        } catch (e) {
            addLog('Warmup attempt ' + (attempt + 1) + ' failed: ' + e.message, 'error');

            if (attempt < maxRetries) {
                const delay = delays[attempt];
                addLog('Retrying in ' + delay + 'ms... (attempt ' + (attempt + 2) + '/' + (maxRetries + 1) + ')', 'info');
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                addLog('All warmup attempts failed. Click "Reload Scripts" to retry manually.', 'error');
            }
        }
    }
}

/**
 * Ensure assets directory exists
 */
function ensureAssetsDir() {
    try {
        if (!fs.existsSync(ASSETS_DIR)) {
            fs.mkdirSync(ASSETS_DIR, { recursive: true });
        }
    } catch (e) {
        console.error('Error creating assets directory:', e);
    }
}

/**
 * Initialize custom select component
 */
function initCustomSelect() {
    const container = document.querySelector('.custom-select-container');
    const trigger = document.getElementById('customAssetType');
    const optionsContainer = document.getElementById('customAssetOptions');
    const hiddenInput = document.getElementById('assetType');
    const typeLabel = trigger.querySelector('.type-label');
    const typeIconWrapper = trigger.querySelector('.type-icon');

    if (!container || !trigger || !optionsContainer || !hiddenInput) return;

    // Populate options if empty
    if (optionsContainer.children.length === 0) {
        const types = [
            { value: 'video', label: 'Video' },
            { value: 'transition', label: 'Transition' },
            { value: 'effect', label: 'Effect' },
            { value: 'text', label: 'Text' },
            { value: 'audio', label: 'Audio' },
            { value: 'overlay', label: 'Overlay' },
            { value: 'background', label: 'Background' },
            { value: 'mogrt', label: 'MOGRT' },
            { value: 'other', label: 'Other' }
        ];

        types.forEach(type => {
            const div = document.createElement('div');
            div.className = 'custom-option';
            div.dataset.value = type.value;

            // Use strict matching for icons
            const iconHtml = ASSET_TYPE_ICONS[type.value] || ASSET_TYPE_ICONS['other'];

            div.innerHTML = `
                    <span class="type-icon">${iconHtml}</span>
                    <span class="type-label">${type.label}</span>
                `;

            div.addEventListener('click', function (e) {
                e.stopPropagation();
                // Update hidden input
                hiddenInput.value = type.value;

                // Update subcategories based on type
                if (typeof populateSubcategories === 'function') {
                    populateSubcategories(type.value);
                }

                // Update trigger UI
                typeLabel.textContent = type.label;
                typeIconWrapper.innerHTML = iconHtml;

                // Update selection state
                document.querySelectorAll('.custom-option').forEach(opt => opt.classList.remove('selected'));
                div.classList.add('selected');

                // Close dropdown
                container.classList.remove('open');
            });

            optionsContainer.appendChild(div);
        });
    }

    // Toggle dropdown
    trigger.onclick = function (e) {
        e.stopPropagation();
        // Close other dropdowns if any (like save menu)
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
        container.classList.toggle('open');
    };

    // Close when clicking outside
    document.addEventListener('click', function (e) {
        if (!container.contains(e.target)) {
            container.classList.remove('open');
        }
    });

    // Set initial state based on hidden input
    const currentVal = hiddenInput.value || 'video';
    const initialOption = optionsContainer.querySelector(`[data-value="${currentVal}"]`);
    if (initialOption) {
        typeLabel.textContent = initialOption.querySelector('.type-label').textContent;
        typeIconWrapper.innerHTML = initialOption.querySelector('.type-icon').innerHTML;
        initialOption.classList.add('selected');
    }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Save button
    saveAssetBtn.addEventListener('click', showSaveDialog);

    // Dialog buttons
    cancelSaveBtn.addEventListener('click', hideSaveDialog);
    confirmSaveBtn.addEventListener('click', confirmSaveAsset);

    // Enter key in input
    assetNameInput.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            confirmSaveAsset();
        }
    });

    // Click outside dialog to close - Disabled
    /* saveDialog.addEventListener('click', function (e) {
        if (e.target === saveDialog) {
            hideSaveDialog();
        }
    }); */

    // Initialize toolbar events (called on init and after module switch)
    initToolbarEvents();
}

/**
 * Initialize/reinitialize toolbar event listeners
 * Called on startup and when switching back to Assets module
 */
function initToolbarEvents() {
    // Save button
    const saveBtn = document.getElementById('saveAssetBtn');
    if (saveBtn) {
        saveBtn.onclick = showSaveDialog;
    }

    // Dropdown toggle
    const dropdownToggle = document.getElementById('saveDropdownToggle');
    const dropdownMenu = document.getElementById('saveDropdownMenu');

    if (dropdownToggle && dropdownMenu) {
        // Function to handle toggle
        const toggleMenu = function (e) {
            e.stopPropagation();
            // Toggle show class
            const isShown = dropdownMenu.classList.contains('show');

            // Close all other dropdowns first (if any)
            document.querySelectorAll('.dropdown-menu.show').forEach(m => {
                if (m !== dropdownMenu) m.classList.remove('show');
            });

            if (isShown) {
                dropdownMenu.classList.remove('show');
            } else {
                dropdownMenu.classList.add('show');
            }
        };

        dropdownToggle.onclick = toggleMenu;
    }

    // Menu items
    const menuSave = document.getElementById('menuSave');
    if (menuSave) {
        menuSave.onclick = function () {
            dropdownMenu?.classList.remove('show');
            showSaveDialog();
        };
    }

    const menuImport = document.getElementById('menuImport');
    const importPickerEl = document.getElementById('importPicker');
    if (menuImport && importPickerEl) {
        menuImport.onclick = function () {
            dropdownMenu?.classList.remove('show');
            importPickerEl.click();
        };
    }

    // Search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.oninput = function () {
            searchFilter = this.value.toLowerCase();
            renderAssets();
        };
    }
}

/**
 * Setup event listeners (continued)
 */
function setupEventListenersContinued() {
    // Debug buttons
    if (clearLogBtn) {
        clearLogBtn.addEventListener('click', function () {
            debugLog.innerHTML = '';
        });
    }

    // Debug panel toggle
    const toggleDebug = document.getElementById('toggleDebug');
    const debugPanel = document.getElementById('debugPanel');
    if (toggleDebug && debugPanel) {
        // Restore collapsed state from localStorage
        if (localStorage.getItem('vt_debug_collapsed') === 'false') {
            debugPanel.classList.remove('collapsed');
        }
        toggleDebug.addEventListener('click', function () {
            debugPanel.classList.toggle('collapsed');
            localStorage.setItem('vt_debug_collapsed', debugPanel.classList.contains('collapsed'));
        });
    }

    if (testCmdsBtn) {
        testCmdsBtn.addEventListener('click', function () {
            // First test DLL
            addLog('=== Testing DLL ===', 'info');
            csInterface.evalScript('VT_testDllCommand()', function (dllResult) {
                addLog('DLL Test Result: ' + dllResult);
                try {
                    const parsed = JSON.parse(dllResult);
                    if (parsed.error) {
                        addLog('DLL ERROR: ' + parsed.error, 'error');
                    } else if (parsed.testCommand === 'true') {
                        addLog('DLL working correctly!', 'info');
                    } else {
                        addLog('DLL command returned: ' + parsed.testCommand, 'error');
                    }
                } catch (e) {
                    addLog('Parse error: ' + e, 'error');
                }
            });

            // Then test QE
            addLog('Testing QE API methods...', 'info');
            csInterface.evalScript('VT_testQEMethods()', function (result) {
                try {
                    var data = JSON.parse(result);
                    addLog('QE Available: ' + data.qeAvailable);
                    if (data.appMethods && data.appMethods.length > 0) {
                        addLog('APP Methods: ' + data.appMethods.join(', '), 'info');
                    }
                    addLog('QE Methods: ' + data.qeMethods.join(', '));
                    addLog('QE Project Methods: ' + data.qeProjectMethods.join(', '));
                    if (data.interestingMethods.length > 0) {
                        addLog('INTERESTING: ' + data.interestingMethods.join(', '), 'info');
                    } else {
                        addLog('No executeCommand found', 'error');
                    }
                } catch (e) {
                    addLog('Result: ' + result);
                }
            });
        });
    }

    // Reload Scripts button
    if (reloadScriptsBtn) {
        reloadScriptsBtn.addEventListener('click', function () {
            addLog('Reloading ExtendScript...', 'info');
            // Force reload by re-evaluating the script
            const scriptPath = extensionDir + '/jsx/hostscript.jsx';
            csInterface.evalScript('$.evalFile("' + scriptPath.replace(/\\/g, '/') + '")', function (result) {
                addLog('Script reloaded: ' + result);
                // Re-initialize DLL after reload (VT_ExtObj was reset to null)
                csInterface.evalScript('VT_initExtObj()', function (dllResult) {
                    addLog('DLL re-initialized: ' + dllResult);
                    // Fetch and display new version
                    fetchScriptVersion();
                });
            });
        });
    }

    // Fetch script version on startup
    fetchScriptVersion();

    // Category sidebar click handler
    if (categorySidebar) {
        categorySidebar.addEventListener('click', function (e) {
            const tile = e.target.closest('.category-tile');
            if (!tile) return;

            const category = tile.dataset.category;
            if (!category) return;

            // Update active state
            categorySidebar.querySelectorAll('.category-tile').forEach(t => t.classList.remove('active'));
            tile.classList.add('active');

            // Update selected category and re-render
            if (selectedCategory === category) return;
            selectedCategory = category;

            // Hide audio preview when switching
            if (AudioPreview) AudioPreview.hide();

            renderAssets();
        });

        // Spotlight glass effect - track mouse position on each tile
        categorySidebar.querySelectorAll('.category-tile').forEach(tile => {
            tile.addEventListener('mousemove', function (e) {
                const rect = tile.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * 100;
                const y = ((e.clientY - rect.top) / rect.height) * 100;
                tile.style.setProperty('--mouse-x', x + '%');
                tile.style.setProperty('--mouse-y', y + '%');
            });
        });
    }

    // Sidebar toggle (collapse/expand)
    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle && categorySidebar) {
        // Restore state from localStorage
        if (localStorage.getItem('vt_sidebar_collapsed') === 'true') {
            categorySidebar.classList.add('collapsed');
        }

        sidebarToggle.addEventListener('click', function () {
            if (!assetGrid) {
                categorySidebar.classList.toggle('collapsed');
                localStorage.setItem('vt_sidebar_collapsed', categorySidebar.classList.contains('collapsed'));
                return;
            }

            const cards = Array.from(assetGrid.querySelectorAll('.asset-card'));
            if (cards.length === 0) {
                categorySidebar.classList.toggle('collapsed');
                localStorage.setItem('vt_sidebar_collapsed', categorySidebar.classList.contains('collapsed'));
                return;
            }

            // 1. Get first states
            const firstStates = cards.map(card => {
                const rect = card.getBoundingClientRect();
                const parentRect = assetGrid.getBoundingClientRect();
                return {
                    element: card,
                    left: rect.left - parentRect.left + assetGrid.scrollLeft,
                    top: rect.top - parentRect.top + assetGrid.scrollTop,
                    width: rect.width,
                    height: rect.height
                };
            });

            // 2. Measure ending state
            // Disable transitions to get final state instantly
            const origTransition = categorySidebar.style.transition;
            categorySidebar.style.transition = 'none';
            
            categorySidebar.classList.toggle('collapsed');
            
            // Force reflow
            const reflow1 = assetGrid.offsetHeight;

            const lastStates = cards.map(card => {
                const rect = card.getBoundingClientRect();
                const parentRect = assetGrid.getBoundingClientRect();
                return {
                    left: rect.left - parentRect.left + assetGrid.scrollLeft,
                    top: rect.top - parentRect.top + assetGrid.scrollTop,
                    width: rect.width,
                    height: rect.height
                };
            });

            // Revert to first state (temporarily)
            categorySidebar.classList.toggle('collapsed');
            const reflow2 = assetGrid.offsetHeight;
            categorySidebar.style.transition = origTransition;

            // 3. Put cards in absolute positioning at first state
            const origHeight = assetGrid.offsetHeight;
            assetGrid.style.height = origHeight + 'px';
            
            firstStates.forEach(state => {
                const card = state.element;
                card.style.position = 'absolute';
                card.style.left = state.left + 'px';
                card.style.top = state.top + 'px';
                card.style.width = state.width + 'px';
                card.style.height = state.height + 'px';
                card.style.margin = '0';
                card.style.transition = 'none';
            });

            // 4. Trigger the real transition
            categorySidebar.classList.toggle('collapsed');
            localStorage.setItem('vt_sidebar_collapsed', categorySidebar.classList.contains('collapsed'));

            const isCollapsing = categorySidebar.classList.contains('collapsed');
            
            // Timing configuration for Staggered Wave animation
            const baseDuration = isCollapsing ? 300 : 400; // ms
            const baseDelay = isCollapsing ? 250 : 0; // ms
            const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
            const totalDuration = baseDelay + baseDuration + (cards.length * 20);

            // 5. Animate to last state
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    firstStates.forEach((state, i) => {
                        const card = state.element;
                        const last = lastStates[i];
                        const delay = baseDelay + i * 20; // 20ms stagger per card

                        card.style.transition = `left ${baseDuration}ms ${easing} ${delay}ms, top ${baseDuration}ms ${easing} ${delay}ms, width ${baseDuration}ms ${easing} ${delay}ms, height ${baseDuration}ms ${easing} ${delay}ms`;
                        card.style.left = last.left + 'px';
                        card.style.top = last.top + 'px';
                        card.style.width = last.width + 'px';
                        card.style.height = last.height + 'px';
                    });
                });
            });

            // 6. Cleanup
            setTimeout(() => {
                firstStates.forEach(state => {
                    const card = state.element;
                    card.style.position = '';
                    card.style.left = '';
                    card.style.top = '';
                    card.style.width = '';
                    card.style.height = '';
                    card.style.margin = '';
                    card.style.transition = '';
                });
                assetGrid.style.height = '';
            }, totalDuration + 50);
        });
    }

    // Module tabs switching
    const moduleTabs = document.querySelectorAll('.module-tab');
    const mainContent = document.querySelector('.main-content');

    moduleTabs.forEach(tab => {
        tab.addEventListener('click', function () {
            const module = this.dataset.module;

            // Update active tab
            moduleTabs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');

            // Store active module
            localStorage.setItem('vt_active_module', module);

            // Hide audio preview when switching modules
            if (AudioPreview) AudioPreview.hide();

            // Handle module switching
            if (module === 'assets') {
                if (categorySidebar) categorySidebar.style.display = '';
                if (assetGrid) assetGrid.style.display = '';
                document.querySelector('.bottom-toolbar')?.style.setProperty('display', '');
                document.getElementById('toolbarAssets').style.display = '';
                document.getElementById('toolbarCaptions').style.display = 'none';
                loadAssets();
                setStatus('Assets module');
            } else if (module === 'captions') {
                if (categorySidebar) categorySidebar.style.display = 'none';
                document.querySelector('.bottom-toolbar')?.style.setProperty('display', 'none');
                document.getElementById('toolbarAssets').style.display = 'none';
                document.getElementById('toolbarCaptions').style.display = '';
                if (assetGrid) {
                    assetGrid.innerHTML = `
                            <div class="empty-state">
                                <div class="empty-icon">
                                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary); opacity: 0.5;">
                                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                                    </svg>
                                </div>
                                <p>Captions Create</p>
                                <p class="hint">Coming soon...</p>
                            </div>
                        `;
                }
                setStatus('Captions module - coming soon');
            }

            addLog('Switched to module: ' + module);
        });
    });

    // Restore active module from localStorage
    const savedModule = localStorage.getItem('vt_active_module') || 'assets';
    const savedTab = document.querySelector(`.module-tab[data-module="${savedModule}"]`);
    if (savedTab && savedModule !== 'assets') {
        savedTab.click();
    }

    // Hide menus on click outside
    document.addEventListener('click', function () {
        if (contextMenu) contextMenu.style.display = 'none';
        if (saveDropdownMenu) saveDropdownMenu.classList.remove('show');
    });

    // Context menu: Add Preview
    const ctxAddPreview = document.getElementById('ctxAddPreview');
    if (ctxAddPreview) {
        ctxAddPreview.addEventListener('click', function () {
            if (previewPicker && contextMenuAsset) {
                previewPicker.click();
            }
            contextMenu.style.display = 'none';
        });
    }

    // Context menu: Remove Preview
    const ctxRemovePreview = document.getElementById('ctxRemovePreview');
    if (ctxRemovePreview) {
        ctxRemovePreview.addEventListener('click', function () {
            if (contextMenuAsset) {
                const previewPath = getPreviewPath(contextMenuAsset.path);
                if (fs.existsSync(previewPath)) {
                    fs.unlinkSync(previewPath);
                    invalidatePreviewCache(contextMenuAsset.id || contextMenuAsset.path);
                    invalidateCardCache(contextMenuAsset.id);
                    addLog('Removed preview: ' + previewPath);
                    renderAssets();
                }
            }
            contextMenu.style.display = 'none';
        });
    }

    // Context menu: Delete Asset
    const ctxDelete = document.getElementById('ctxDelete');
    if (ctxDelete) {
        ctxDelete.addEventListener('click', function () {
            if (selectedAssetIds.size > 1 && contextMenuAsset && selectedAssetIds.has(contextMenuAsset.id)) {
                batchDeleteAssets(Array.from(selectedAssetIds));
            } else if (contextMenuAsset) {
                deleteAsset(contextMenuAsset);
            }
            contextMenu.style.display = 'none';
        });
    }

    /**
     * Batch delete assets
     * @param {string[]} ids - Array of asset IDs
     */
    async function batchDeleteAssets(ids) {
        if (!ids || ids.length === 0) return;

        const confirmed = await showDeleteDialog(`${ids.length} selected items`);
        if (!confirmed) return;

        setStatus(`Deleting ${ids.length} assets...`);

        let deletedCount = 0;

        for (const id of ids) {
            const asset = assets.find(a => a.id === id);
            if (asset) {
                try {
                    // Delete files
                    const prprojPath = asset.path;
                    const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
                    const previewPath = getPreviewPath(asset.path);

                    if (fs.existsSync(prprojPath)) fs.unlinkSync(prprojPath);
                    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
                    if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);

                    // Remove from memory
                    assets = assets.filter(a => a.id !== id);
                    deletedCount++;
                } catch (e) {
                    console.error('Error deleting asset ' + id, e);
                    addLog('Error deleting asset ' + id + ': ' + e, 'error');
                }
            }
        }

        selectedAssetIds.clear();
        invalidateAllCardCache();
        renderAssets();
        setStatus(`Deleted ${deletedCount} assets`);
        addLog(`Batch deleted ${deletedCount} assets`);
    }

    // Context menu: Rename Asset
    const ctxRename = document.getElementById('ctxRename');
    const renameDialog = document.getElementById('renameDialog');
    const renameInput = document.getElementById('renameInput');
    const cancelRenameBtn = document.getElementById('cancelRename');
    const confirmRenameBtn = document.getElementById('confirmRename');
    let renameAsset = null;

    if (ctxRename) {
        ctxRename.addEventListener('click', function () {
            if (contextMenuAsset) {
                renameAsset = contextMenuAsset;
                renameInput.value = contextMenuAsset.name;
                renameDialog.style.display = 'flex';
                renameInput.focus();
                renameInput.select();
            }
            contextMenu.style.display = 'none';
        });
    }

    if (cancelRenameBtn) {
        cancelRenameBtn.addEventListener('click', function () {
            renameDialog.style.display = 'none';
            renameAsset = null;
        });
    }

    if (confirmRenameBtn) {
        confirmRenameBtn.addEventListener('click', performRename);
    }

    if (renameInput) {
        renameInput.addEventListener('keyup', function (e) {
            if (e.key === 'Enter') {
                performRename();
            } else if (e.key === 'Escape') {
                renameDialog.style.display = 'none';
                renameAsset = null;
            }
        });
    }

    function performRename() {
        if (!renameAsset) return;
        const newName = renameInput.value.trim();

        if (newName && newName !== renameAsset.name) {
            try {
                // Update metadata
                const metaPath = renameAsset.path.replace('.prproj', '.json');
                const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                metadata.name = newName;
                fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

                // Update in-memory array
                const assetIndex = assets.findIndex(a => a.id === renameAsset.id);
                if (assetIndex >= 0) {
                    assets[assetIndex].name = newName;
                }

                addLog('Renamed asset to: ' + newName);
                invalidateCardCache(renameAsset.id);
                renderAssets();
            } catch (err) {
                addLog('Error renaming asset: ' + err, 'error');
            }
        }

        renameDialog.style.display = 'none';
        renameAsset = null;
    }

    // Context menu: Edit Subcategory
    const ctxEditSubcat = document.getElementById('ctxEditSubcat');
    const subcatChangeDialog = document.getElementById('subcatChangeDialog');
    const subcatChangeInput = document.getElementById('subcatChangeInput');
    const subcatArrow = document.getElementById('subcatArrow');
    const subcatSuggestions = document.getElementById('subcatSuggestions');
    const subcatChangeCancel = document.getElementById('subcatChangeCancel');
    const subcatChangeConfirm = document.getElementById('subcatChangeConfirm');
    let subcatChangeAsset = null;
    let subcatChangeIsBatch = false;

    // Populate and show subcategory suggestions
    function showSubcatSuggestions() {
        const existingSubcats = new Set();
        assets.forEach(a => {
            if (a.subcategory) existingSubcats.add(a.subcategory);
        });

        subcatSuggestions.innerHTML = '';
        Array.from(existingSubcats).sort().forEach(sub => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.textContent = sub;
            item.addEventListener('click', () => {
                subcatChangeInput.value = sub;
                subcatSuggestions.style.display = 'none';
            });
            subcatSuggestions.appendChild(item);
        });

        if (existingSubcats.size > 0) {
            subcatSuggestions.style.display = 'block';
        }
    }

    if (ctxEditSubcat) {
        ctxEditSubcat.addEventListener('click', function () {
            // Check for batch selection (must include the right-clicked item)
            // If right-click on non-selected item, selection is reset to single item by card contextmenu handler first.
            if (selectedAssetIds.size > 1 && contextMenuAsset && selectedAssetIds.has(contextMenuAsset.id)) {
                // Batch Mode
                subcatChangeIsBatch = true;
                subcatChangeAsset = null;
                subcatChangeInput.value = '';
                subcatChangeInput.placeholder = `(Set for ${selectedAssetIds.size} items)`;
            } else if (contextMenuAsset) {
                // Single Mode
                subcatChangeIsBatch = false;
                subcatChangeAsset = contextMenuAsset;
                subcatChangeInput.value = contextMenuAsset.subcategory || '';
                subcatChangeInput.placeholder = 'Enter subcategory...';
            }

            // Common Dialog Open
            if (subcatChangeIsBatch || subcatChangeAsset) {
                subcatSuggestions.style.display = 'none';
                subcatChangeDialog.style.display = 'flex';
                subcatChangeInput.focus();
                // Select only if single mode or if input has value
                if (!subcatChangeIsBatch) subcatChangeInput.select();
            }
            contextMenu.style.display = 'none';
        });
    }

    // Arrow toggle for suggestions
    if (subcatArrow) {
        subcatArrow.addEventListener('click', function (e) {
            e.stopPropagation();
            if (subcatSuggestions.style.display === 'none') {
                showSubcatSuggestions();
            } else {
                subcatSuggestions.style.display = 'none';
            }
        });
    }

    // Hide suggestions on outside click
    if (subcatChangeDialog) {
        subcatChangeDialog.addEventListener('click', function (e) {
            if (!e.target.closest('.input-wrapper')) {
                subcatSuggestions.style.display = 'none';
            }
        });
    }

    if (subcatChangeCancel) {
        subcatChangeCancel.addEventListener('click', function () {
            subcatChangeDialog.style.display = 'none';
            subcatChangeAsset = null;
            subcatChangeIsBatch = false;
        });
    }

    if (subcatChangeConfirm) {
        subcatChangeConfirm.addEventListener('click', function () {
            const newSubcat = subcatChangeInput.value.trim() || null;

            if (subcatChangeIsBatch) {
                // Batch processing
                let changedCount = 0;
                Array.from(selectedAssetIds).forEach(id => {
                    const asset = assets.find(a => a.id === id);
                    if (asset) {
                        applySubcategoryChange(asset, newSubcat, true); // true = skipRender
                        changedCount++;
                    }
                });
                invalidateAllCardCache();
                renderAssets(); // Render once at the end
                addLog(`Batch updated subcategory for ${changedCount} items`);
                setStatus(`Updated ${changedCount} items`);

                // Clear batch selection? Maybe keep it.
                // selectedAssetIds.clear(); 
            } else {
                if (!subcatChangeAsset) return;
                applySubcategoryChange(subcatChangeAsset, newSubcat, false);
            }

            subcatChangeDialog.style.display = 'none';
            subcatChangeAsset = null;
            subcatChangeIsBatch = false;
        });
    }

    function applySubcategoryChange(asset, newSubcat, skipRender = false) {
        try {
            // Update in-memory
            // Use loose comparison just in case
            const assetIndex = assets.findIndex(a => String(a.id) === String(asset.id));

            if (assetIndex >= 0) {
                if (newSubcat) {
                    assets[assetIndex].subcategory = newSubcat;
                } else {
                    delete assets[assetIndex].subcategory;
                }

                // Write to file
                const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
                if (fs.existsSync(metaPath)) {
                    fs.writeFileSync(metaPath, JSON.stringify(assets[assetIndex], null, 2));
                }

                addLog(`Changed subcategory of "${asset.name}" to: ${newSubcat || '(none)'}`);
                invalidateCardCache(asset.id);
                if (!skipRender) renderAssets();
            } else {
                addLog(`Error: Asset index not found for ${asset.name}`, 'error');
            }
        } catch (err) {
            addLog('Error changing subcategory: ' + err, 'error');
        }
    }

    // File picker change handler - copy selected video as preview
    if (previewPicker) {
        previewPicker.addEventListener('change', function (e) {
            if (!e.target.files.length || !contextMenuAsset) return;

            const sourceFile = e.target.files[0].path;
            const destPath = getPreviewPath(contextMenuAsset.path);

            try {
                fs.copyFileSync(sourceFile, destPath);
                invalidatePreviewCache(contextMenuAsset.id || contextMenuAsset.path);
                invalidateCardCache(contextMenuAsset.id);
                addLog('Added preview: ' + destPath);
                renderAssets();
            } catch (err) {
                addLog('Error copying preview: ' + err, 'error');
            }

            // Reset picker
            previewPicker.value = '';
        });
    }

    // Import file picker change handler
    if (importPicker) {
        importPicker.addEventListener('change', function (e) {
            if (!e.target.files.length) return;
            pendingImportFile = e.target.files[0].path;

            // 1. Show dialog first
            saveDialog.style.display = 'flex';

            // 2. Initialize UI components
            initCustomSelect();
            populateSubcategories();

            // 3. Auto-detect type and update Select UI
            const autoType = detectTypeFromExtension(pendingImportFile);
            // Re-query options after init
            const targetOption = Array.from(document.querySelectorAll('.custom-option')).find(el => el.dataset.value === autoType);
            if (targetOption) {
                targetOption.click();
            }

            filterAssetTypes(autoType);
            populateSubcategories(autoType);
            // 4. Set name
            assetNameInput.value = path.basename(pendingImportFile, path.extname(pendingImportFile));
            assetNameInput.focus();
            importPicker.value = '';
        });
    }

    // Drag & drop files onto asset grid
    if (assetGrid) {
        assetGrid.addEventListener('dragover', function (e) {
            // Only show drop zone for external files (not asset cards)
            if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                assetGrid.classList.add('drop-zone');
            }
        });

        assetGrid.addEventListener('dragleave', function (e) {
            if (!assetGrid.contains(e.relatedTarget)) {
                assetGrid.classList.remove('drop-zone');
            }
        });

        assetGrid.addEventListener('drop', function (e) {
            assetGrid.classList.remove('drop-zone');
            if (e.dataTransfer.files.length > 0) {
                e.preventDefault();
                pendingImportFile = e.dataTransfer.files[0].path;

                // 1. Show dialog first
                saveDialog.style.display = 'flex';

                // 2. Initialize UI components
                initCustomSelect();
                populateSubcategories();

                // 3. Auto-detect type and update Select UI
                const autoType = detectTypeFromExtension(pendingImportFile);
                const targetOption = Array.from(document.querySelectorAll('.custom-option')).find(el => el.dataset.value === autoType);
                if (targetOption) targetOption.click();
                filterAssetTypes(autoType);
                populateSubcategories(autoType);

                // 4. Set name
                assetNameInput.value = path.basename(pendingImportFile, path.extname(pendingImportFile));
                assetNameInput.focus();
            }
        });
    }

    // Bottom toolbar: Zoom slider (Discrete Snapping)
    const zoomSlider = document.getElementById('zoomSlider');
    if (zoomSlider && assetGrid) {
        const snapWidths = {
            1: '110px', // Small
            2: '160px', // Medium
            3: '100%'   // Full width (1 column)
        };

        // Restore saved step
        const savedStep = localStorage.getItem('vt_zoom_step') || '2';
        zoomSlider.value = savedStep;
        assetGrid.style.setProperty('--card-min-width', snapWidths[savedStep]);

        zoomSlider.addEventListener('input', function (e) {
            const step = e.target.value;
            // Set exact min-width via CSS variable
            assetGrid.style.setProperty('--card-min-width', snapWidths[step]);
            localStorage.setItem('vt_zoom_step', step);
        });
    }

    // Bottom toolbar: Aspect ratio toggle
    const aspectBtns = document.querySelectorAll('.aspect-btn');
    aspectBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            aspectBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Update card thumbnails aspect ratio
            const aspect = btn.dataset.aspect;
            document.documentElement.style.setProperty('--card-aspect', aspect === '9:16' ? '9/16' : '16/9');
        });
    });
}

/**
 * Fetch and display ExtendScript version
 */
function fetchScriptVersion() {
    csInterface.evalScript('VT_getVersion()', function (result) {
        try {
            const data = JSON.parse(result);
            if (scriptVersionEl && data.version) {
                scriptVersionEl.textContent = 'v' + data.version;
                addLog('ExtendScript version: ' + data.version, 'info');
            }
        } catch (e) {
            if (scriptVersionEl) {
                scriptVersionEl.textContent = 'v?.?.?';
            }
            addLog('Could not get script version: ' + result, 'error');
        }
    });
}

/**
 * Add log entry to debug panel
 */

let subCatAppsInitialized = false;

function populateSubcategories(typeFilter) {
    const subInput = document.getElementById('assetSubcategory');
    if (subInput) subInput.value = '';

    // If no explicit filter, try to get from hidden input
    if (!typeFilter) {
        const typeInput = document.getElementById('assetType');
        if (typeInput) typeFilter = typeInput.value;
    }

    const dropdown = document.getElementById('subSuggestions');
    const arrow = document.getElementById('subArrow');

    if (dropdown) {
        dropdown.innerHTML = '';
        const subs = new Set();
        assets.forEach(a => {
            // Filter by type
            const matchesType = !typeFilter || a.type === typeFilter;
            if (a.subcategory && matchesType) subs.add(a.subcategory);
        });

        if (subs.size > 0) {
            Array.from(subs).sort().forEach(s => {
                const div = document.createElement('div');
                div.className = 'suggestion-item';
                div.textContent = s;
                div.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (subInput) subInput.value = s;
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(div);
            });
            if (arrow) arrow.style.display = 'block';
        } else {
            if (arrow) arrow.style.display = 'none';
        }
    }

    // Initialize events once
    if (!subCatAppsInitialized) {
        subCatAppsInitialized = true;
        if (arrow && dropdown) {
            arrow.addEventListener('click', function (e) {
                e.stopPropagation();
                const isVisible = dropdown.style.display === 'block';
                if (dropdown.children.length > 0) {
                    dropdown.style.display = isVisible ? 'none' : 'block';
                }
            });

            // Close on outside click
            document.addEventListener('click', function (e) {
                if (dropdown.style.display === 'block' && !dropdown.contains(e.target) && e.target !== arrow && e.target !== subInput) {
                    dropdown.style.display = 'none';
                }
            });

            if (subInput) {
                subInput.addEventListener('click', function () {
                    if (dropdown.children.length > 0) dropdown.style.display = 'block';
                });
                subInput.addEventListener('input', function () {
                    dropdown.style.display = 'none';
                });
            }
        }
    }
}

function filterAssetTypes(detectType) {
    const opts = document.querySelectorAll('.custom-option');
    opts.forEach(o => o.style.display = 'none');

    const show = (val) => {
        const el = document.querySelector(`.custom-option[data-value="${val}"]`);
        if (el) el.style.display = 'flex';
    };

    show('other');

    if (detectType === 'audio') {
        show('audio');
    } else if (detectType === 'video') {
        show('video'); show('background'); show('overlay');
    } else if (detectType === 'image') {
        show('overlay'); show('background');
    } else if (detectType === 'mogrt') {
        show('mogrt');
    } else {
        show('video'); show('audio'); show('overlay'); show('background'); show('mogrt');
    }
}

function resetAssetTypes() {
    document.querySelectorAll('.custom-option').forEach(o => o.style.display = '');
}

/**
 * Show save dialog
 */
function showSaveDialog() {
    setStatus('Checking selection...');

    // Check if there's a selection in Premiere
    csInterface.evalScript('VT_hasSelection()', function (result) {
        if (result === 'true') {
            resetAssetTypes();
            saveDialog.style.display = 'flex';
            populateSubcategories();
            assetNameInput.value = '';
            assetNameInput.focus();

            // Initialize custom select
            initCustomSelect();

            setStatus('Enter asset name');
        } else {
            setStatus('No clips selected! Select clips on timeline first.');
            setTimeout(() => setStatus('Ready'), 3000);
        }
    });
}

/**
 * Hide save dialog
 */
function hideSaveDialog() {
    saveDialog.style.display = 'none';
    setStatus('Ready');
}

/**
 * Show duplicate asset warning dialog
 * @returns {Promise<boolean>} true if user wants to continue, false to cancel
 */
function showDuplicateDialog(assetName) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('duplicateDialog');
        const message = document.getElementById('duplicateMessage');
        const confirmBtn = document.getElementById('duplicateConfirm');
        const cancelBtn = document.getElementById('duplicateCancel');

        if (!dialog) {
            // Fallback if dialog not found
            resolve(confirm(`Asset "${assetName}" already exists. Add anyway?`));
            return;
        }

        message.textContent = `An asset named "${assetName}" already exists in your library.`;
        dialog.style.display = 'flex';

        const cleanup = () => {
            dialog.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        };

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };

        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
    });
}

/**
 * Confirm and save asset
 * Uses copy/paste workflow to preserve effects
 * Or imports external file if pendingImportFile is set
 */
async function confirmSaveAsset() {
    const name = assetNameInput.value.trim();
    const subcat = document.getElementById('assetSubcategory') ? document.getElementById('assetSubcategory').value.trim() : '';
    const type = assetTypeSelect ? assetTypeSelect.value : 'other';

    if (!name) {
        assetNameInput.focus();
        return;
    }

    // Check for duplicate name
    const existingAsset = assets.find(a => a.name.toLowerCase() === name.toLowerCase());
    if (existingAsset) {
        const shouldContinue = await showDuplicateDialog(name);
        if (!shouldContinue) {
            assetNameInput.focus();
            assetNameInput.select();
            return;
        }
    }

    hideSaveDialog();

    // Check if this is an import (external file) or save (from timeline)
    if (pendingImportFile) {
        // IMPORT external file
        setStatus('Importing file...');
        addLog('=== Importing File: ' + name + ' (' + type + ') ===', 'info');

        const assetId = 'asset_' + Date.now();
        const ext = path.extname(pendingImportFile);
        const assetPath = path.join(ASSETS_DIR, assetId + ext);

        try {
            // Copy file to assets folder
            fs.copyFileSync(pendingImportFile, assetPath);
            addLog('Copied to: ' + assetPath);

            // Save metadata
            const metadata = {
                id: assetId,
                name: name,
                subcategory: subcat || undefined,
                type: type,
                path: assetPath,
                isExternal: true, // Mark as imported (not .prproj)
                created: new Date().toISOString()
            };

            const metaPath = path.join(ASSETS_DIR, assetId + '.json');
            fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
            assets.push(metadata);
            renderAssets();
            setStatus('Imported: ' + name);
            addLog('=== SUCCESS! ===');
        } catch (err) {
            addLog('Import error: ' + err, 'error');
            setStatus('Import failed!');
        }

        pendingImportFile = null;
        return;
    }

    // SAVE from timeline (original logic)
    setStatus('Saving asset...');
    addLog('=== Saving Asset: ' + name + ' (' + type + ') ===', 'info');

    // Generate unique ID
    const assetId = 'asset_' + Date.now();
    const assetPath = path.join(ASSETS_DIR, assetId + '.prproj');
    const escapedPath = assetPath.replace(/\\/g, '\\\\');

    try {
        // Show blocking overlay
        const savingOverlay = document.getElementById('savingOverlay');
        const savingText = document.getElementById('savingText');
        const savingSubtext = document.getElementById('savingSubtext');

        if (savingOverlay) {
            savingText.textContent = 'Saving asset...';
            savingSubtext.textContent = 'Please wait, do not interact with Premiere Pro';
            savingOverlay.style.display = 'flex';
        }

        // Play warning beep
        playBeep('start');

        // Show status that we're generating preview (UI may freeze during render)
        setStatus('Saving & generating preview...');
        addLog('Saving with native DLL (preview generation may freeze UI briefly)...');

        // Update overlay for preview generation
        if (savingOverlay && savingText) {
            savingText.textContent = 'Generating preview...';
            savingSubtext.textContent = 'Rendering 480p preview, this may take a few seconds';
        }

        const result = await evalScriptAsync(`VT_saveAssetNative("${escapedPath}")`);
        addLog('Result: ' + result);

        // Parse result
        const parsed = JSON.parse(result);

        if (parsed.success) {
            addLog('Copy: ' + parsed.copyResult + ', Paste: ' + parsed.pasteResult);

            // Log preview status
            if (parsed.previewGenerated) {
                addLog('Preview generated: ' + parsed.previewPath, 'success');
            } else {
                addLog('Preview not generated (VideoSample or preset missing)', 'warning');
            }

            // Save metadata
            const metadata = {
                id: assetId,
                name: name,
                subcategory: subcat || undefined,
                type: type,
                path: assetPath,
                created: new Date().toISOString()
            };

            const metaPath = path.join(ASSETS_DIR, assetId + '.json');
            fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
            assets.push(metadata);
            renderAssets();

            const previewMsg = parsed.previewGenerated ? ' (with preview)' : '';
            setStatus('Asset saved: ' + name + previewMsg);
            addLog('=== SUCCESS! ===');
            playBeep('success');
        } else {
            throw new Error(parsed.error || 'Save failed');
        }
    } catch (error) {
        addLog('ERROR: ' + error.message, 'error');
        setStatus('Error saving asset');
        playBeep('error');
    } finally {
        // Always hide overlay
        const savingOverlay = document.getElementById('savingOverlay');
        if (savingOverlay) {
            savingOverlay.style.display = 'none';
        }
    }
}

/**
 * Load assets from disk
 */
function loadAssets() {
    assets = [];
    addLog('loadAssets: Loading assets from ' + ASSETS_DIR, 'info');

    try {
        if (!fs.existsSync(ASSETS_DIR)) {
            addLog('loadAssets: ASSETS_DIR does not exist!', 'warning');
            return;
        }

        const files = fs.readdirSync(ASSETS_DIR);
        addLog('loadAssets: Found ' + files.length + ' files in assets directory', 'info');

        files.forEach(function (file) {
            if (file.endsWith('.json')) {
                try {
                    const metaPath = path.join(ASSETS_DIR, file);
                    const content = fs.readFileSync(metaPath, 'utf8');
                    const metadata = JSON.parse(content);

                    addLog('loadAssets: Processing JSON file: ' + file + ' for asset: ' + metadata.name, 'info');

                    // Check if .prproj file or external file exists
                    let fileExists = false;
                    if (metadata.path) {
                        fileExists = fs.existsSync(metadata.path);
                        addLog('loadAssets: Checking path: ' + metadata.path + ' -> ' + fileExists, 'info');
                    } else {
                        addLog('loadAssets: Asset ' + metadata.name + ' has no path in metadata!', 'warning');
                    }

                    if (fileExists) {
                        assets.push(metadata);
                    } else {
                        addLog('loadAssets: Asset file NOT found, skipping: ' + metadata.path, 'warning');
                    }
                } catch (e) {
                    console.error('Error loading asset:', file, e);
                    addLog('loadAssets: Error parsing asset file ' + file + ': ' + e.message, 'error');
                }
            }
        });

        addLog('loadAssets: Loaded ' + assets.length + ' valid assets', 'success');
        invalidateAllCardCache();
        renderAssets();
    } catch (e) {
        console.error('Error loading assets:', e);
        addLog('loadAssets: Critical error loading assets: ' + e.message, 'error');
    }
}

let activeSubcategory = new Set(['All']);

function detectTypeFromExtension(filepath) {
    if (!filepath) return 'other';
    const ext = path.extname(filepath).toLowerCase();
    if (['.mp3', '.wav', '.aac', '.m4a', '.aif', '.aiff'].includes(ext)) return 'audio';
    if (['.mp4', '.mov', '.mxf', '.avi', '.mpg', '.webm', '.mkv'].includes(ext)) return 'video';
    if (['.png', '.jpg', '.jpeg', '.tiff', '.webp', '.bmp', '.psd', '.ai'].includes(ext)) return 'image'; // mapped to image/overlay
    if (ext === '.mogrt') return 'mogrt';
    return 'other';
}

function renderFilterChips(categoryAssets) {
    const filterBar = document.getElementById('filterBar');
    if (!filterBar) return;

    const subcats = new Set(['All']);
    let hasSubcats = false;

    categoryAssets.forEach(a => {
        if (a.subcategory) {
            subcats.add(a.subcategory);
            hasSubcats = true;
        }
    });

    // Validate active chip (reset vs current set)
    // Filter active set to only include valid subcats
    const validActive = new Set();
    activeSubcategory.forEach(c => {
        if (subcats.has(c)) validActive.add(c);
    });
    // If no valid selection left, default to All
    if (validActive.size === 0) validActive.add('All');
    activeSubcategory = validActive;

    if (!hasSubcats || subcats.size <= 1) {
        filterBar.style.display = 'none';
        activeSubcategory = new Set(['All']);
        return;
    }

    filterBar.style.display = 'flex';
    filterBar.innerHTML = '';

    // Convert to array and sort (All first, then alphabetical)
    const sortedCats = Array.from(subcats).sort((a, b) => {
        if (a === 'All') return -1;
        if (b === 'All') return 1;
        return a.localeCompare(b);
    });

    // HYBRID MODE: Show first MAX_VISIBLE_CHIPS, rest in dropdown
    const MAX_VISIBLE_CHIPS = 6;
    const visibleCats = sortedCats.slice(0, MAX_VISIBLE_CHIPS);
    const hiddenCats = sortedCats.slice(MAX_VISIBLE_CHIPS);

    // Render visible chips
    visibleCats.forEach(cat => {
        const chip = createFilterChip(cat, categoryAssets);
        filterBar.appendChild(chip);
    });

    // Render "More" dropdown if there are hidden chips
    if (hiddenCats.length > 0) {
        const moreContainer = document.createElement('div');
        moreContainer.className = 'filter-chip-more-container';

        const moreBtn = document.createElement('div');
        moreBtn.className = 'filter-chip filter-chip-more';
        // Check if ANY active subcategory is in hidden list
        const activeInHidden = hiddenCats.some(c => activeSubcategory.has(c));
        if (activeInHidden) {
            moreBtn.classList.add('has-active');
        }
        moreBtn.innerHTML = `<span>More</span><span style="opacity:0.7; font-size:10px;">+${hiddenCats.length}</span>`;

        const dropdown = document.createElement('div');
        dropdown.className = 'filter-chip-dropdown';

        hiddenCats.forEach(cat => {
            const isActive = activeSubcategory.has(cat);
            const item = document.createElement('div');
            item.className = `filter-chip-dropdown-item ${isActive ? 'active' : ''}`;
            const count = categoryAssets.filter(a => a.subcategory === cat).length;
            item.innerHTML = `<span class="chip-label">${cat}</span><span class="chip-count">${count}</span>`;

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                // Multi-select toggle logic
                if (cat === 'All') { // Should not happen in hidden usually
                    activeSubcategory.clear();
                    activeSubcategory.add('All');
                } else {
                    if (activeSubcategory.has('All')) activeSubcategory.delete('All');

                    if (activeSubcategory.has(cat)) {
                        activeSubcategory.delete(cat);
                        if (activeSubcategory.size === 0) activeSubcategory.add('All');
                    } else {
                        activeSubcategory.add(cat);
                    }
                }
                // Keep dropdown open for multi-select? Maybe better UX.
                // Or close it? User asked for multi-select. Usually dropdowns close.
                // But for filters, keeping open is nice. Let's keep it open but update UI.
                // Actually, re-rendering renders everything including closing logic.
                // If we renderAssets(), it rebuilds the whole bar.
                renderAssets();
            });

            // Context menu for dropdown items
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                dropdown.classList.remove('show');
                showChipContextMenu(e.clientX, e.clientY, cat);
            });

            dropdown.appendChild(item);
        });

        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.contains('show');

            // Close any other open dropdowns first
            document.querySelectorAll('.filter-chip-dropdown.show').forEach(d => d.classList.remove('show'));

            if (!isOpen) {
                dropdown.classList.add('show');

                // Close on outside click (delayed to prevent immediate trigger)
                setTimeout(() => {
                    const closeHandler = (evt) => {
                        if (!moreContainer.contains(evt.target)) {
                            dropdown.classList.remove('show');
                            document.removeEventListener('click', closeHandler);
                        }
                    };
                    document.addEventListener('click', closeHandler);
                }, 10);
            }
        });

        moreContainer.appendChild(moreBtn);
        moreContainer.appendChild(dropdown);
        filterBar.appendChild(moreContainer);
    }

    // Initialize rename events if not already
    if (typeof setupSubcatRenameEvents === 'function' && !window.subcatRenameInitialized) {
        setupSubcatRenameEvents();
        window.subcatRenameInitialized = true;
    }
}

/**
 * Create a single filter chip element
 */
function createFilterChip(cat, categoryAssets) {
    const chip = document.createElement('div');
    const isActive = activeSubcategory.has(cat);
    chip.className = `filter-chip ${isActive ? 'active' : ''}`;

    const count = categoryAssets.filter(a => cat === 'All' || a.subcategory === cat).length;
    chip.innerHTML = `<span class="chip-label">${cat}</span><span class="chip-count">${count}</span>`;

    chip.addEventListener('click', () => {
        // Toggle logic
        if (cat === 'All') {
            activeSubcategory.clear();
            activeSubcategory.add('All');
        } else {
            if (activeSubcategory.has('All')) activeSubcategory.delete('All');

            if (activeSubcategory.has(cat)) {
                activeSubcategory.delete(cat);
                if (activeSubcategory.size === 0) activeSubcategory.add('All');
            } else {
                activeSubcategory.add(cat);
            }
        }
        renderAssets();
    });

    // Add Context Menu and Drag & Drop (except for 'All')
    if (cat !== 'All') {
        chip.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showChipContextMenu(e.clientX, e.clientY, cat);
        });

        // Drag & Drop assignment
        chip.addEventListener('dragover', (e) => {
            e.preventDefault(); // Allow drop
            e.dataTransfer.dropEffect = 'copy';
            chip.classList.add('drag-over');
        });

        chip.addEventListener('dragleave', () => {
            chip.classList.remove('drag-over');
        });

        chip.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Stop bubbling
            chip.classList.remove('drag-over');

            // Try dataTransfer first, fall back to global variable
            let assetId = e.dataTransfer.getData('text/plain');
            if (!assetId && window._internalDragAssetId) {
                assetId = window._internalDragAssetId;
            }

            if (assetId) {
                // Use loose string comparison to avoid type issues
                const asset = assets.find(a => String(a.id) === String(assetId));

                if (asset) {
                    if (asset.subcategory !== cat) {
                        applySubcategoryChange(asset, cat);
                    } else {
                    }
                } else {
                    addLog('Error: Asset not found for ID: ' + assetId, 'error');
                }
            }
            // Clear global
            window._internalDragAssetId = null;
        });
    }

    return chip;
}

function showChipContextMenu(x, y, name) {
    // Hide main context menu if visible
    const mainCtx = document.getElementById('contextMenu');
    if (mainCtx) mainCtx.style.display = 'none';

    // Remove existing dynamic menus
    const existing = document.querySelectorAll('.context-menu:not(#contextMenu)');
    existing.forEach(e => e.remove());

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block'; // Ensure it's visible based on CSS

    // Rename option
    const itemRename = document.createElement('div');
    itemRename.className = 'context-item';
    itemRename.innerHTML = `
        <svg viewBox="0 0 24 24" class="ctx-icon"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path class="accent" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Rename
    `;
    itemRename.onclick = () => {
        if (window.openSubcatRename) window.openSubcatRename(name);
        menu.remove();
    };

    // Delete option
    const itemDelete = document.createElement('div');
    itemDelete.className = 'context-item context-delete';
    itemDelete.innerHTML = `
        <svg viewBox="0 0 24 24" class="ctx-icon ctx-icon-delete"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        Delete
    `;
    itemDelete.onclick = () => {
        if (confirm('Delete category "' + name + '" from all assets?')) {
            deleteSubcategory(name);
        }
        menu.remove();
    };

    menu.appendChild(itemRename);
    menu.appendChild(itemDelete);
    document.body.appendChild(menu);

    // Close on next click
    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            // Don't close if clicking inside the menu
            if (menu.contains(e.target)) return;

            menu.remove();
            document.removeEventListener('click', close);
        });
    }, 0);
}

function setupSubcatRenameEvents() {
    const dialog = document.getElementById('subcatRenameDialog');
    const input = document.getElementById('subcatRenameInput');
    const confirmBtn = document.getElementById('confirmSubcatRename');
    const cancelBtn = document.getElementById('cancelSubcatRename');
    let currentOldName = null;

    window.openSubcatRename = (oldName) => {
        currentOldName = oldName;
        input.value = oldName;
        dialog.style.display = 'flex';
        input.focus();
        input.select();
    };

    const close = () => {
        dialog.style.display = 'none';
        currentOldName = null;
    };

    if (cancelBtn) cancelBtn.onclick = close;

    const perform = () => {
        const newName = input.value.trim();
        if (newName && currentOldName && newName !== currentOldName) {
            updateSubcategoryName(currentOldName, newName);
        }
        close();
    };

    if (confirmBtn) confirmBtn.onclick = perform;
    if (input) {
        input.onkeyup = (e) => {
            if (e.key === 'Enter') perform();
            if (e.key === 'Escape') close();
        };
    }
}

function updateSubcategoryName(oldName, newName) {
    let updatedCount = 0;
    assets.forEach(asset => {
        if (asset.subcategory === oldName) {
            asset.subcategory = newName;
            // Update file
            try {
                const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
                if (fs.existsSync(metaPath)) {
                    // Start reading fresh to avoid overwrite race? No, we trust memory 'assets' is up to date vs disk structure
                    // But good practice to read-modify-write if properties exist that are not in 'assets' array
                    // 'assets' array has full metadata.
                    fs.writeFileSync(metaPath, JSON.stringify(asset, null, 2));
                    updatedCount++;
                }
            } catch (e) { console.error('Error updating asset ' + asset.id, e); }
        }
    });

    if (updatedCount > 0) {
        addLog(`Renamed category "${oldName}" to "${newName}" in ${updatedCount} assets.`);
        if (activeSubcategory.has(oldName)) {
            activeSubcategory.delete(oldName);
            activeSubcategory.add(newName);
        }
        renderAssets();
    }
}

function deleteSubcategory(name) {
    let updatedCount = 0;
    assets.forEach(asset => {
        if (asset.subcategory === name) {
            delete asset.subcategory; // Remove property? Or set to undefined?
            // JSON.stringify will skip undefined.
            // Update file
            try {
                const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
                if (fs.existsSync(metaPath)) {
                    fs.writeFileSync(metaPath, JSON.stringify(asset, null, 2));
                    updatedCount++;
                }
            } catch (e) { console.error('Error updating asset ' + asset.id, e); }
        }
    });

    if (updatedCount > 0) {
        addLog(`Deleted category "${name}" from ${updatedCount} assets.`);
        if (activeSubcategory.has(name)) {
            activeSubcategory.delete(name);
            if (activeSubcategory.size === 0) activeSubcategory.add('All');
        }
        invalidateAllCardCache();
        renderAssets();
    }
}

/**
 * Card DOM cache avoids re-creating cards on every category switch.
 * Key = asset.id, Value = DOM element returned by createAssetCard().
 */
const _cardCache = new Map();
let _initialRenderDone = false;

/**
 * Invalidate a single card in the cache (e.g. after rename, preview change).
 */
function invalidateCardCache(assetId) {
    _cardCache.delete(assetId);
}

/**
 * Force a full cache rebuild on next render (e.g. after asset list changes).
 */
function invalidateAllCardCache() {
    _cardCache.clear();
    _initialRenderDone = false;
}

/**
 * IntersectionObserver for lazy-loading heavy card content (video src, waveforms).
 * Cards register via data-lazy-src (video) or data-lazy-waveform (audio canvas).
 * Content is loaded only when the card scrolls into view.
 */
const _lazyCardObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        const card = entry.target;

        // Lazy-load video preview
        const video = card.querySelector('video[data-lazy-src]');
        if (video && !video.src) {
            video.src = video.getAttribute('data-lazy-src');
            video.removeAttribute('data-lazy-src');
        }

        // Lazy-generate waveform
        const canvas = card.querySelector('canvas[data-lazy-waveform]');
        if (canvas && !canvas._waveformLoaded) {
            canvas._waveformLoaded = true;
            const audioPath = canvas.getAttribute('data-audio-path');
            // Defer slightly so layout is settled
            requestAnimationFrame(async function () {
                const rect = canvas.parentElement.getBoundingClientRect();
                // Force a high resolution multiplier (3x) because devicePixelRatio
                // can be unreliable in CEP panels and cause blurriness.
                const dpr = 3; 
                canvas.width = Math.floor((rect.width || 200) * dpr);
                canvas.height = Math.floor((rect.height || 80) * dpr);
                const waveformData = await generateWaveform(audioPath);
                setupStaticWaveform(canvas, waveformData);
            });
        }

        // Once loaded, stop observing this card
        _lazyCardObserver.unobserve(card);
    });
}, { root: assetGrid, rootMargin: '200px 0px' });

/**
 * Render asset grid optimised version.
 *
 * Instead of destroying every card on each category switch, we:
 *  1. Cache card DOM nodes by asset.id so they are reused.
 *  2. Build the new visible set in a DocumentFragment and swap in one go.
 *  3. Only play the staggered entrance animation on the very first render;
 *     subsequent renders simply show the cards immediately.
 */
function renderAssets() {
    // 1. Filter by Main Category
    let filterBase = assets;
    if (selectedCategory === 'recent') {
        filterBase = recentAssets
            .map(id => assets.find(a => a.id === id))
            .filter(Boolean);
    } else if (selectedCategory === 'favorites') {
        const favSet = getFavoritesSet();
        filterBase = assets.filter(a => favSet.has(a.id));
    } else if (selectedCategory !== 'all') {
        filterBase = assets.filter(a => a.type === selectedCategory);
    }

    // 2. Render Filter Chips (before subcat filtering)
    renderFilterChips(filterBase);

    // 3. Apply Subcategory Filter
    let filteredAssets = filterBase;
    if (!activeSubcategory.has('All')) {
        filteredAssets = filteredAssets.filter(a => {
            return a.subcategory && activeSubcategory.has(a.subcategory);
        });
    }

    // 4. Apply Search Filter
    if (searchFilter) {
        filteredAssets = filteredAssets.filter(a =>
            a.name.toLowerCase().includes(searchFilter)
        );
    }

    // 5. Update sidebar counts
    updateCategoryCounts();

    // 6. Build the visible card set
    // Detach existing children without destroying them (keep in cache)
    while (assetGrid.firstChild) {
        assetGrid.removeChild(assetGrid.firstChild);
    }

    // Always re-attach emptyState node
    if (emptyState) {
        assetGrid.appendChild(emptyState);
    }

    if (filteredAssets.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    // Prune stale cache entries (assets that no longer exist)
    const currentIds = new Set(assets.map(a => a.id));
    for (const cachedId of _cardCache.keys()) {
        if (!currentIds.has(cachedId)) _cardCache.delete(cachedId);
    }

    const shouldAnimate = !_initialRenderDone;
    const fragment = document.createDocumentFragment();
    const newCards = []; // Cards that need entrance animation

    for (let i = 0; i < filteredAssets.length; i++) {
        const asset = filteredAssets[i];
        let card = _cardCache.get(asset.id);

        if (!card) {
            // Create new card and cache it
            card = createAssetCard(asset);
            _cardCache.set(asset.id, card);

            if (shouldAnimate) {
                card.classList.add('card-entering');
                newCards.push(card);
            } else {
                // Skip animation show immediately
                card.classList.add('card-entered');
            }
        } else {
            // Reuse cached card make sure it's visible and up-to-date
            // Update selection state
            if (selectedAssetIds.has(asset.id)) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
            }
            // Re-observe for lazy loading if content hasn't been loaded yet
            if (card.querySelector('video[data-lazy-src]') || card.querySelector('canvas[data-lazy-waveform]:not([data-loaded])')) {
                _lazyCardObserver.observe(card);
            }
        }
        fragment.appendChild(card);
    }

    assetGrid.appendChild(fragment);

    // Staggered entrance animation only for first load
    if (shouldAnimate && newCards.length > 0) {
        _initialRenderDone = true;
        requestAnimationFrame(function () {
            newCards.forEach(function (card, i) {
                setTimeout(function () {
                    card.classList.remove('card-entering');
                    card.classList.add('card-entered');
                }, i * 20);
            });
        });
    } else {
        _initialRenderDone = true;
    }
}

/**
 * Update category counter badges
 */
function updateCategoryCounts() {
    var allCount = document.getElementById('count-all');
    if (allCount) allCount.textContent = assets.length;

    var recentSet = new Set(recentAssets);
    var favSet = getFavoritesSet();

    var counts = { recent: 0, favorites: 0 };
    var types = ['video', 'transition', 'effect', 'text', 'audio', 'overlay', 'background', 'mogrt', 'other'];
    var typeCounts = {};
    types.forEach(function (t) { typeCounts[t] = 0; });

    assets.forEach(function (a) {
        if (recentSet.has(a.id)) counts.recent++;
        if (favSet.has(a.id)) counts.favorites++;
        if (typeCounts[a.type] !== undefined) typeCounts[a.type]++;
    });

    var recentCount = document.getElementById('count-recent');
    if (recentCount) recentCount.textContent = counts.recent;
    var favoritesCount = document.getElementById('count-favorites');
    if (favoritesCount) favoritesCount.textContent = counts.favorites;
    types.forEach(function (type) {
        var countEl = document.getElementById('count-' + type);
        if (countEl) countEl.textContent = typeCounts[type];
    });
}

/**
 * Add asset to recent list
 */
function addToRecent(assetId) {
    // Remove if already in list
    recentAssets = recentAssets.filter(id => id !== assetId);
    // Add to front
    recentAssets.unshift(assetId);
    // Keep only MAX_RECENT
    recentAssets = recentAssets.slice(0, MAX_RECENT);
    // Save to localStorage
    localStorage.setItem('vt_recent_assets', JSON.stringify(recentAssets));
}

/**
 * Get icon for asset type - using SVG from sidebar
 */
const ASSET_TYPE_ICONS = {
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="4" ry="4"></rect><polygon class="accent" points="10 9 15 12 10 15 10 9"></polygon></svg>',
    transition: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path class="accent" d="M8 12l8 0"></path><path class="accent" d="M13 9l3 3-3 3"></path></svg>',
    effect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"></path><path class="accent" d="M12 4v2M12 18v2M4 12h2M18 12h2M6.34 6.34l1.42 1.42M16.24 16.24l1.42 1.42M6.34 17.66l1.42-1.42M16.24 7.76l1.42-1.42"></path></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"></path><path d="M9 20h6"></path><line class="accent" x1="12" y1="4" x2="12" y2="20"></line></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6"></path><path class="accent" d="M15 21V3"></path><path d="M5 15v-6"></path><path d="M19 15v-6"></path></svg>',
    overlay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline class="accent" points="2 12 12 17 22 12"></polyline></svg>',
    background: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle class="accent" cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
    mogrt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4" ry="4"></rect><circle class="accent" cx="12" cy="12" r="3"></circle></svg>',
    other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"></path><path class="accent" d="M12 12v9"></path></svg>'
};

function getAssetIcon(type) {
    return ASSET_TYPE_ICONS[type] || ASSET_TYPE_ICONS.other;
}

const TYPE_LABELS = {
    video: 'Video',
    transition: 'Transition',
    effect: 'Effect',
    text: 'Text',
    audio: 'Audio',
    overlay: 'Overlay',
    background: 'Background',
    mogrt: 'MOGRT',
    other: 'Other'
};

/**
 * Create an asset card element
 */
function createAssetCard(asset) {
    const card = document.createElement('div');
    card.className = 'asset-card';

    // Pre-compute these values for use in event handlers
    const hasPreviewFile = hasPreview(asset);
    const isAudio = isAudioFile(asset.path);
    const isMogrt = isMogrtFile(asset.path);

    // Selection State
    if (selectedAssetIds.has(asset.id)) {
        card.classList.add('selected');
    }

    // Click Handler for Selection
    card.addEventListener('click', (e) => {
        // Ignore clicks on favorite button or context menu trigger
        if (e.target.closest('.asset-favorite') || e.button === 2) return;

        const isMulti = e.ctrlKey || e.metaKey;
        const isRange = e.shiftKey;

        if (isRange && lastSelectedAssetId) {
            // Range Selection
            const allCards = Array.from(document.querySelectorAll('.asset-card'));
            const lastIdx = allCards.findIndex(c => c.dataset.assetId === lastSelectedAssetId);
            const currIdx = allCards.findIndex(c => c.dataset.assetId === asset.id);

            if (lastIdx !== -1 && currIdx !== -1) {
                const start = Math.min(lastIdx, currIdx);
                const end = Math.max(lastIdx, currIdx);

                // If not holding Ctrl, clear previous unless range extension
                if (!isMulti) {
                    selectedAssetIds.clear();
                    allCards.forEach(c => c.classList.remove('selected'));
                }

                for (let i = start; i <= end; i++) {
                    const cid = allCards[i].dataset.assetId;
                    selectedAssetIds.add(cid);
                    allCards[i].classList.add('selected');
                }
            }
        } else if (isMulti) {
            // Toggle Selection
            if (selectedAssetIds.has(asset.id)) {
                selectedAssetIds.delete(asset.id);
                card.classList.remove('selected');
            } else {
                selectedAssetIds.add(asset.id);
                card.classList.add('selected');
                lastSelectedAssetId = asset.id;
            }
        } else {
            // Single Selection
            selectedAssetIds.clear();
            document.querySelectorAll('.asset-card.selected').forEach(c => c.classList.remove('selected'));

            selectedAssetIds.add(asset.id);
            card.classList.add('selected');
            lastSelectedAssetId = asset.id;
        }

        // Show Audio Preview for audio files (if single or last selected)
        if (isAudio && AudioPreview) {
            AudioPreview.show(asset);
        } else if (AudioPreview && !isMulti && !isRange) {
            // If we clicked a non-audio asset (single click), hide preview
            if (!isAudio) AudioPreview.hide();
        }

        // Update Status
        if (selectedAssetIds.size > 1) {
            setStatus(`${selectedAssetIds.size} assets selected`);
        } else {
            setStatus('Double-click to apply "' + asset.name + '"');
        }
    });

    // Add class if preview exists
    if (hasPreviewFile) {
        card.classList.add('has-preview');
    }

    card.setAttribute('draggable', 'true');
    card.dataset.assetId = asset.id;
    card.dataset.assetPath = asset.path;
    card.dataset.assetType = asset.type || 'other';

    // Detect icon by extension for special file types (isAudio/isMogrt already computed at top)
    let icon;

    if (isMogrt) {
        icon = '📊'; // MOGRT icon
    } else if (isAudio) {
        icon = '🎵'; // Audio icon
    } else {
        icon = getAssetIcon(asset.type);
    }

    const previewPath = getPreviewPath(asset.path);
    // hasPreviewFile was already calculated above

    const typeLabel = TYPE_LABELS[asset.type] || 'Asset';
    const isFavorite = getFavoritesSet().has(asset.id);

    // Build thumbnail content
    let thumbnailContent;
    let needsWaveformSetup = false;

    if (hasPreviewFile) {
        // Lazy: video src is set by IntersectionObserver when card enters viewport
        thumbnailContent = `<video class="asset-preview" data-lazy-src="file://${previewPath}" loop muted playsinline preload="metadata"></video>`;
    } else if (isAudio) {
        // Canvas for interactive waveform – lazy generated via observer
        thumbnailContent = `<canvas class="waveform-canvas" data-audio-path="${asset.path}" data-lazy-waveform></canvas>`;
        needsWaveformSetup = true;
    } else {
        // Icon with watermark effect
        thumbnailContent = `
                <div class="watermark-bg">${icon}</div>
                <div class="asset-icon">${icon}</div>
            `;
    }

    // Build meta label (TYPE - Subcategory)
    let metaLabel = typeLabel;
    if (asset.subcategory) {
        metaLabel += ` · ${asset.subcategory}`;
    }

    card.innerHTML = `
            <button class="asset-favorite" title="Add to favorites"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"></polygon></svg></button>
            <div class="asset-thumbnail${hasPreviewFile ? ' has-preview' : ''}">
                ${thumbnailContent}
            </div>
            <div class="asset-info">
                <div class="asset-name" title="${asset.name}">${asset.name}</div>
                <div class="asset-meta">${metaLabel}</div>
            </div>
        `;

    // Right-click context menu
    card.addEventListener('contextmenu', function (e) {
        e.preventDefault();

        // Close any dynamic context menus (like chip menus)
        const dynamicMenus = document.querySelectorAll('.context-menu:not(#contextMenu)');
        dynamicMenus.forEach(m => m.remove());

        // Batch Selection Logic for Right Click
        // If the right-clicked item is NOT in the selection, clear and select it (standard OS behavior)
        if (!selectedAssetIds.has(asset.id)) {
            selectedAssetIds.clear();
            selectedAssetIds.add(asset.id);
            document.querySelectorAll('.asset-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
        }

        contextMenuAsset = asset;
        const selectionCount = selectedAssetIds.size;
        const isBatch = selectionCount > 1;

        // UI Updates for Batch
        const deleteBtn = document.getElementById('ctxDelete');
        const renameBtn = document.getElementById('ctxRename');
        const subcatBtn = document.getElementById('ctxEditSubcat');
        const explorerBtn = document.getElementById('ctxExplorer');
        const previewBtn = document.getElementById('ctxAddPreview');
        const removePreviewBtn = document.getElementById('ctxRemovePreview');

        if (isBatch) {
            // Batch Mode
            deleteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon ctx-icon-delete"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                Delete (${selectionCount}) items
            `;
            subcatBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon"><path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9z" /><path class="accent" d="M16 9V7a4 4 0 0 0-8 0v2" /></svg>
                Edit Subcategory (${selectionCount})
            `;

            // Hide single-item actions
            if (renameBtn) renameBtn.style.display = 'none';
            if (explorerBtn) explorerBtn.style.display = 'none';
            if (previewBtn) previewBtn.style.display = 'none';
            if (removePreviewBtn) removePreviewBtn.style.display = 'none';

        } else {
            // Single Item Mode (Restore defaults)
            deleteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon ctx-icon-delete"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                Delete
            `;
            subcatBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon"><path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9z" /><path class="accent" d="M16 9V7a4 4 0 0 0-8 0v2" /></svg>
                Edit Subcategory
            `;

            if (renameBtn) renameBtn.style.display = 'block';
            if (explorerBtn) explorerBtn.style.display = 'block';
            if (previewBtn) previewBtn.style.display = 'block';
            if (removePreviewBtn) {
                removePreviewBtn.style.display = hasPreviewFile ? 'block' : 'none';
            }
        }

        // Show/hide remove preview based on whether preview exists (Only relevant in single mode handled above)

        // Context Actions

        // First, show menu temporarily (maybe off-screen) to calculate its size
        contextMenu.style.display = 'block';
        
        let x = e.clientX;
        let y = e.clientY;
        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;
        
        // If menu goes off the right edge, flip it to the left of the cursor
        if (x + menuWidth > window.innerWidth) {
            x = e.clientX - menuWidth;
        }
        
        // If menu goes off the bottom edge, flip it above the cursor
        if (y + menuHeight > window.innerHeight) {
            y = e.clientY - menuHeight;
        }
        
        // Safety bounds to ensure it doesn't go off the top/left edge in very small windows
        x = Math.max(5, x);
        y = Math.max(5, y);

        // Apply final position
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
    });

    // Double-click to apply asset at playhead
    card.addEventListener('dblclick', function (e) {
        e.preventDefault();
        applyAsset(asset);
    });

    // Hover to play video preview (works with lazy-loaded src)
    const videoEl = card.querySelector('.asset-preview');
    if (videoEl) {
        // When metadata loads, seek to 25% for thumbnail (avoids black frames from fade-in effects)
        videoEl.addEventListener('loadedmetadata', function () {
            const thumbnailPos = videoEl.duration * 0.25;
            videoEl.currentTime = thumbnailPos;
        });

        card.addEventListener('mouseenter', function () {
            // Only play if src has been loaded by the lazy observer
            if (!videoEl.src) return;
            videoEl.currentTime = 0;
            videoEl.play().catch(() => { });
        });
        card.addEventListener('mouseleave', function () {
            if (!videoEl.src) return;
            videoEl.pause();
            // Return to 25% position for thumbnail
            const thumbnailPos = videoEl.duration ? videoEl.duration * 0.25 : 0;
            videoEl.currentTime = thumbnailPos;
        });
    }

    // Favorite button toggle
    const favBtn = card.querySelector('.asset-favorite');
    if (favBtn) {
        // Set initial state
        if (isFavorite) {
            favBtn.classList.add('active');
        }

        favBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            let favorites = JSON.parse(localStorage.getItem('vt_favorites') || '[]');

            if (favorites.includes(asset.id)) {
                favorites = favorites.filter(id => id !== asset.id);
                favBtn.classList.remove('active');
            } else {
                favorites.push(asset.id);
                favBtn.classList.add('active');
            }

            localStorage.setItem('vt_favorites', JSON.stringify(favorites));
            invalidateFavoritesCache();

            // Refresh grid if we are in Favorites view, or just update counts
            if (selectedCategory === 'favorites') {
                renderAssets();
            } else {
                updateCategoryCounts();
            }
        });
    }

    // Drag start - use native file for external assets, .vtbk for .prproj
    card.addEventListener('dragstart', function (e) {
        card.classList.add('dragging');

        // GLOBAL INTERNAL DRAG FALLBACK
        window._internalDragAssetId = asset.id;

        // Custom Ghost Image
        const ghost = document.getElementById('dragGhost');
        const ghostIcon = ghost.querySelector('.drag-ghost-icon');
        if (ghost && ghostIcon) {
            // Copy icon from card
            ghostIcon.innerHTML = isMogrt ? '📊' : (isAudio ? '🎵' : getAssetIcon(asset.type));
            // Better: clone the actual icon element from the card to keep styles
            const cardIcon = card.querySelector('.asset-icon svg, .asset-icon');
            if (cardIcon) {
                ghostIcon.innerHTML = cardIcon.outerHTML;
            }

            // Set drag image (offset by -20px so it floats above/left of cursor)
            // The 2nd and 3rd args are the position of the cursor RELATIVE to the image top-left
            // So if we set it to (50, 50) the image will be drawn so that the cursor is heavily inside it.
            // If we want the image to be AWAY from cursor, we need to be clever.
            // Actually, HTML5 setDragImage doesn't support negative offsets well in all browsers,
            // but setting it to the bottom-right corner of the image (e.g. 48, 48) makes the image appear Top-Left of cursor.

            // Set drag image (offset by -20px so it floats meant to be Bottom-Right)
            // Image location = (mouseX - x, mouseY - y)
            // We want Image = (mouseX + 20, mouseY + 20) -> x = -20, y = -20
            e.dataTransfer.setDragImage(ghost, -20, -20);
        }

        let dragPath;

        // MOGRT files need placeholder system for position detection
        // (importMGT API requires time parameter)
        if (isMogrtFile(asset.path)) {
            dragPath = createVtbkFile(asset);
            if (!dragPath) {
                addLog('ERROR: Failed to create .vtbk file for MOGRT', 'error');
                e.preventDefault();
                return;
            }

            // Store for placeholder replacement with MOGRT
            window._vtDraggedAsset = asset;
            addLog('MOGRT drag with placeholder: ' + dragPath, 'info');
            setStatus('Drop MOGRT on timeline...');
        }
        // External files (video/audio but NOT mogrt)
        else if (asset.isExternal) {
            // Audio files: use .vtbk placeholder so we can apply pitch/reverse via polling+replacePlaceholder
            if (isAudioFile(asset.path)) {
                dragPath = createVtbkFile(asset);
                if (!dragPath) {
                    addLog('ERROR: Failed to create .vtbk file for audio', 'error');
                    e.preventDefault();
                    return;
                }
                window._vtDraggedAsset = asset;
                addLog('Audio drag with placeholder: ' + dragPath, 'info');
                setStatus('Drop audio on timeline...');
            } else {
                // Video/image files: use native path for clean import
                dragPath = asset.path;
                addLog('Native drag for external file: ' + dragPath, 'info');
                window._vtDraggedAsset = null;
                setStatus('Drop "' + asset.name + '" on timeline...');
            }
        } else {
            // .prproj assets - use .vtbk placeholder system for copy/paste workflow
            dragPath = createVtbkFile(asset);
            if (!dragPath) {
                addLog('ERROR: Failed to create .vtbk file', 'error');
                e.preventDefault();
                return;
            }

            // Store for placeholder replacement
            window._vtDraggedAsset = asset;
            addLog('Drag started with .vtbk: ' + dragPath, 'info');
            setStatus('Drop on timeline where you want the asset...');
        }

        // Use CEP native file drag
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('com.adobe.cep.dnd.file.0', dragPath);
        e.dataTransfer.setData('text/plain', asset.id);
    });

    card.addEventListener('dragend', function (e) {
        card.classList.remove('dragging');
        // Clear global
        setTimeout(() => { window._internalDragAssetId = null; }, 100);

        // Only poll for placeholder if using .prproj assets (not external files)
        if (window._vtDraggedAsset) {
            addLog('Drag ended, checking for placeholder...', 'info');
            startPlaceholderPolling(window._vtDraggedAsset);
            window._vtDraggedAsset = null;
        }
    });

    // Register card with lazy observer for video/waveform loading
    if (hasPreviewFile || needsWaveformSetup) {
        _lazyCardObserver.observe(card);
    }

    return card;
}

/**
 * Start polling for placeholder on timeline after drag ends
 * @param {object} asset - The asset that was dragged
 */
function startPlaceholderPolling(asset) {
    let attempts = 0;
    const maxAttempts = 40;
    let isProcessing = false;
    let pollInterval = null;

    pollInterval = setInterval(async function () {
        if (isProcessing || isVtBusy()) return;

        attempts++;

        // Check if placeholder is on timeline
        const result = await evalScriptAsync('VT_findPlaceholder()');

        if (result && result !== 'null' && result !== 'false') {
            // IMMEDIATELY set lock and clear interval BEFORE any async work
            if (isProcessing) return; // Double-check in case of race
            isProcessing = true;
            clearInterval(pollInterval);
            pollInterval = null;

            addLog('Found placeholder at: ' + result, 'info');

            // Replace placeholder with asset (now safe from duplicates)
            await replacePlaceholderWithAsset(asset, result);
        } else if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            pollInterval = null;
            addLog('No placeholder found - drag may have been cancelled', 'info');
            setStatus('Ready');
        }
    }, 25);
}

/**
 * Replace placeholder on timeline with actual asset
 * @param {object} asset - The asset to apply
 * @param {string} placeholderInfo - JSON with placeholder position info
 */
async function replacePlaceholderWithAsset(asset, placeholderInfo) {
    setStatus('Applying "' + asset.name + '" at drop position...');
    addLog('=== Replacing Placeholder with Asset ===', 'info');

    let srcPath = asset.path;
    if (typeof AudioPreview !== 'undefined' && AudioPreview && AudioPreview.asset && AudioPreview.asset.id === asset.id) {
        if (AudioPreview.isProcessing && AudioPreview.processingPromise) {
            setStatus('Rendering pitch accurately with FFmpeg...');
            addLog('Waiting for FFmpeg processing to complete...', 'info');
            setVtBusy(true);
            await AudioPreview.processingPromise;
            setVtBusy(false);
            setStatus('Applying "' + asset.name + '" at drop position...');
        }
        
        if (AudioPreview.processedAudioPath) {
            // The ffmpeg render lives in a temp dir that cleanupTempFiles deletes.
            // Copy it to the permanent dropped folder so the inserted clip keeps its
            // media (no "missing media" once temp is cleaned).
            try {
                if (!fs.existsSync(DROPPED_DIR)) fs.mkdirSync(DROPPED_DIR, { recursive: true });
                const ext = path.extname(AudioPreview.processedAudioPath);
                const permPath = path.join(DROPPED_DIR, 'vt_audio_' + Date.now() + ext);
                fs.copyFileSync(AudioPreview.processedAudioPath, permPath);
                srcPath = permPath;
            } catch (e) {
                srcPath = AudioPreview.processedAudioPath;
                addLog('Could not persist processed audio, using temp: ' + e, 'warning');
            }
        }
    }
    const escapedPath = srcPath.replace(/\\/g, '\\\\');

    try {
        let script;

        const safeplaceholderInfo = placeholderInfo
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'");

        // Build drag options from AudioPreview (pitch/speed/reverse)
        let dragSpeed = 1.0;
        let dragReverse = false;
        if (typeof AudioPreview !== 'undefined' && AudioPreview && AudioPreview.asset && AudioPreview.asset.id === asset.id) {
            dragSpeed = parseFloat(AudioPreview.pitch) || 1.0;
            dragReverse = AudioPreview.reverseCheck ? AudioPreview.reverseCheck.checked : false;
        }
        const dragOptionsStr = JSON.stringify({ speed: dragSpeed, reverse: dragReverse });

        if (isMogrtFile(asset.path)) {
            script = `VT_insertMogrtAtPosition("${escapedPath}", (${safeplaceholderInfo}))`;
            addLog('Using MOGRT insert at position');
        } else if (asset.isExternal) {
            script = `VT_insertExternalFile("${escapedPath}", (${safeplaceholderInfo}), ${dragOptionsStr})`;
            addLog('Using external file insert (speed=' + dragSpeed + ' reverse=' + dragReverse + ')');
        } else {
            addLog('Using single-call drag-drop...', 'info');

            try {
                setVtBusy(true);
                const ddScript = `VT_dragDropSingleCall("${escapedPath}", (${safeplaceholderInfo}), "${asset.type}")`;
                const ddResult = await evalScriptAsync(ddScript);
                setVtBusy(false);

                addLog('Result: ' + ddResult);

                const ddData = JSON.parse(ddResult);
                if (ddData.success) {
                    addToRecent(asset.id);
                    setStatus('Applied: ' + asset.name);
                    addLog('=== SUCCESS! === (' + (ddData.clipsCount || '?') + ' clips)');
                } else {
                    throw new Error('Drag-drop failed: ' + (ddData.error || 'unknown'));
                }

                setTimeout(() => setStatus('Ready'), 2000);
                return;

            } catch (stepErr) {
                setVtBusy(false);
                addLog('Single-call drag-drop error: ' + stepErr.message, 'error');
                addLog('Trying fallback applyAsset...', 'info');
                try {
                    await applyAsset(asset);
                    addLog('=== SUCCESS via fallback! ===');
                    return;
                } catch (fallbackErr) {
                    throw new Error('Drag-drop failed, fallback also failed: ' + stepErr.message);
                }
            }
        }

        // MOGRT and external file paths (single-call, no DLL copy/paste needed)
        if (script) {
            addLog('Executing single-call: ' + script.substring(0, 200) + '...');
            let result = await evalScriptAsync(script);
            addLog('Result: ' + result);

            try {
                const parsed = JSON.parse(result);
                if (parsed.success) {
                    addToRecent(asset.id);
                    setStatus('Applied: ' + asset.name);
                    addLog('=== SUCCESS! ===');
                    // Remove the leftover vt_drag_* placeholder item from the Project
                    // panel - VT_insertExternalFile (audio/MOGRT) doesn't clean the bin
                    // like the .prproj path (VT_dragDropSingleCall) does.
                    try { await evalScriptAsync('VT_cleanupPlaceholdersFromBin()'); } catch (e) {}
                } else {
                    addLog('Error in result: ' + (parsed.error || 'unknown'));
                    setStatus('Error: ' + (parsed.error || 'Failed'));
                }
            } catch (pe) {
                if (result && result.indexOf('success') !== -1) {
                    addToRecent(asset.id);
                    setStatus('Applied: ' + asset.name);
                } else {
                    addLog('Bad result: ' + result);
                }
            }
        }

        setTimeout(() => setStatus('Ready'), 2000);

    } catch (error) {
        addLog('ERROR: ' + error.message, 'error');
        // Try to read debug log
        try {
            const debugLog = await evalScriptAsync('VT_readDebugLog()');
            try {
                const logData = JSON.parse(debugLog);
                if (logData.lines && logData.lines.length > 0) {
                    addLog('--- DEBUG LOG (crash point) ---');
                    logData.lines.forEach(function (l) { if (l.trim()) addLog('  ' + l); });
                    addLog('--- END DEBUG LOG ---');
                }
            } catch (pe) {}
            await evalScriptAsync('VT_clearDebugLog()');
        } catch (dlErr) {}
        setStatus('Error: ' + error.message);
        setTimeout(() => setStatus('Ready'), 3000);
        throw error;
    }
}

/**
 * Helper to Ensure Host Script is Loaded
 */
async function ensureHostScript() {
    // Check if main function exists
    const check = await evalScriptAsync('typeof VT_applyAssetNative');
    if (check !== 'function') {
        addLog('Host script not fully loaded (VT_applyAssetNative type: ' + check + ')', 'warning');
        addLog('Reloading hostscript.jsx...', 'info');

        const scriptPath = extensionDir + '/jsx/hostscript.jsx';
        const loadResult = await evalScriptAsync('$.evalFile("' + scriptPath.replace(/\\/g, '/') + '")');
        addLog('Reload result: ' + loadResult);

        // Force clear old DLL reference to ensure fresh load
        await evalScriptAsync('try { $.global.VT_ExtObj = null; } catch(e) {}');

        // Re-init DLL
        await evalScriptAsync('VT_initExtObj()');

        // Manual definition test
        const manualDef = await evalScriptAsync('function VT_TestManualDef() { return "manual_ok"; }; VT_TestManualDef();');
        addLog('Manual definition test: ' + manualDef);

        // Re-check
        const reCheck = await evalScriptAsync('typeof VT_applyAssetNative');
        addLog('Function status after reload: Native=' + reCheck);
        return (reCheck === 'function');
    }
    // Skip if busy - script already loaded from warmup, DLL alive
    if (isVtBusy()) return true;
    // Ensure DLL is alive (no-op if already loaded, re-inits if Premiere reset it)
    await evalScriptAsync('VT_initExtObj()');
    return true;
}

/**
 * Apply asset to timeline at playhead position
 * Uses Copy/Paste via keyboard simulation
 */
async function applyAsset(asset) {
    setStatus('Applying "' + asset.name + '"...');
    addLog('=== Starting Apply Asset ===', 'info');
    addLog('Asset: ' + asset.name);
    addLog('Path: ' + asset.path);

    // Build apply options
    let applySpeed = 1.0;
    let applyReverse = false;
    let srcPath = asset.path;

    if (typeof AudioPreview !== 'undefined' && AudioPreview && AudioPreview.asset && AudioPreview.asset.id === asset.id) {
        applySpeed = parseFloat(AudioPreview.pitch) || 1.0;
        applyReverse = AudioPreview.reverseCheck ? AudioPreview.reverseCheck.checked : false;
        
        if (AudioPreview.isProcessing && AudioPreview.processingPromise) {
            setStatus('Rendering pitch accurately with FFmpeg...');
            addLog('Waiting for FFmpeg processing to complete...', 'info');
            setVtBusy(true);
            await AudioPreview.processingPromise;
            setVtBusy(false);
            setStatus('Applying "' + asset.name + '"...');
        }

        if (AudioPreview.processedAudioPath) {
            srcPath = AudioPreview.processedAudioPath;
        }
    }

    const escapedPath = srcPath.replace(/\\/g, '\\\\');

    try {
        const optionsStr = JSON.stringify({
            speed: applySpeed,
            reverse: applyReverse
        });

        // Ensure script is loaded
        if (!(await ensureHostScript())) {
            throw new Error('Host script failed to load function VT_applyAssetNative');
        }

        let result;

        // MOGRT files use sequence.importMGT API
        if (isMogrtFile(asset.path)) {
            addLog('Applying MOGRT with importMGT...');
            result = await evalScriptAsync(`VT_insertMogrt("${escapedPath}")`);
            addLog('Result: ' + result);
        } else if (asset.isExternal) {
            addLog('Applying external file (' + (isAudioFile(asset.path) ? 'audio' : 'video') + ') with pitch=' + applySpeed + ' reverse=' + applyReverse);
            const applyOptionsJson = JSON.stringify({ speed: applySpeed, reverse: applyReverse });
            result = await evalScriptAsync(`VT_insertExternalFile("${escapedPath}", null, ${applyOptionsJson})`);
            addLog('Result: ' + result);
        } else {
            // Use native DLL - single call does everything!
            addLog('Applying with native DLL (SAFE)...');
            // Use _Safe version to bypass bytecode cache
            result = await evalScriptAsync(`VT_applyAssetNative_Safe("${escapedPath}", ${JSON.stringify(optionsStr)})`);
            addLog('Result: ' + result);
        }

        // Try to parse as JSON
        try {
            const parsed = JSON.parse(result);
            if (parsed.success) {
                addLog('Copy: ' + parsed.copyResult + ', Paste: ' + parsed.pasteResult + ', Clips: ' + parsed.clipsCount);
                setStatus('Applied: ' + asset.name);
                addLog('=== SUCCESS! ===');
            } else {
                throw new Error(result);
            }
        } catch (parseErr) {
            // Not JSON, check for 'true' or error
            if (result && result.indexOf('success') !== -1) {
                setStatus('Applied: ' + asset.name);
                addLog('=== SUCCESS! ===');
            } else {
                throw new Error(result || 'Unknown error');
            }
        }

        setTimeout(() => setStatus('Ready'), 2000);

    } catch (error) {
        addLog('ERROR: ' + error.message, 'error');
        setStatus('Error: ' + error.message);
        setTimeout(() => setStatus('Ready'), 3000);
        throw error; // Re-throw so callers know it failed
    }
}

/**
 * Promise wrapper for csInterface.evalScript
 */
function evalScriptAsync(script) {
    return new Promise((resolve) => {
        csInterface.evalScript(script, (result) => {
            resolve(result);
        });
    });
}

/**
 * Show delete confirmation dialog
 * @returns {Promise<boolean>}
 */
function showDeleteDialog(assetName) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('deleteDialog');
        const message = document.getElementById('deleteMessage');
        const confirmBtn = document.getElementById('deleteConfirm');
        const cancelBtn = document.getElementById('deleteCancel');

        if (!dialog) {
            resolve(confirm(`Delete asset "${assetName}"?`));
            return;
        }

        message.textContent = `Are you sure you want to delete "${assetName}"?`;
        dialog.style.display = 'flex';

        const cleanup = () => {
            dialog.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        };

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };

        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
    });
}

/**
 * Delete an asset
 */
async function deleteAsset(asset) {
    const confirmed = await showDeleteDialog(asset.name);
    if (!confirmed) {
        return;
    }

    try {
        // Delete files
        const prprojPath = asset.path;
        const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
        const previewPath = getPreviewPath(asset.path);

        if (fs.existsSync(prprojPath)) {
            fs.unlinkSync(prprojPath);
        }
        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
        }
        if (fs.existsSync(previewPath)) {
            fs.unlinkSync(previewPath);
        }

        // Remove from array
        assets = assets.filter(a => a.id !== asset.id);

        invalidateCardCache(asset.id);
        renderAssets();
        setStatus('Asset deleted');
        addLog(`Deleted asset: ${asset.name}`);
    } catch (e) {
        console.error('Error deleting asset:', e);
        setStatus('Error deleting asset');
        addLog('Error deleting asset: ' + e, 'error');
    }
}

/**
 * Set status bar text - silently fail if removed
 */
function setStatus(text) {
    if (typeof statusText !== 'undefined' && statusText) {
        statusText.textContent = text;
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/**
 * Clean up old temp files to prevent disk usage accumulation
 */
function cleanupTempFiles() {
    try {
        const tempDir1 = VTBK_TEMP_DIR;
        const tempDir2 = require('path').join(require('os').homedir(), 'AppData', 'Roaming', 'VibeTools', 'temp');
        
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        // DROPPED_DIR also holds orphaned vt_drag_* placeholders after a swap; sweep
        // those too. vt_audio_* there are real, in-use media and never match the filter.
        [tempDir1, tempDir2, DROPPED_DIR].forEach(dir => {
            if (!require('fs').existsSync(dir)) return;
            const files = require('fs').readdirSync(dir);
            files.forEach(file => {
                if (file.startsWith('vt_drag_') || file.startsWith('ffmpeg_')) {
                    const filePath = require('path').join(dir, file);
                    try {
                        const stats = require('fs').statSync(filePath);
                        if (now - stats.mtimeMs > oneHour) {
                            require('fs').unlinkSync(filePath);
                        }
                    } catch (e) {}
                }
            });
        });
        addLog('Cleaned up old temporary files', 'info');
    } catch (e) {
        console.error('Error cleaning temp files:', e);
    }
}
