// Audio preview subsystem: waveform generation/rendering and the AudioPreview
// player (playback, live pitch via Jungle, on-the-fly pitch/reverse via ffmpeg).
// Extracted from main.js. Jungle is a global provided by js/jungle.js.

import { addLog } from './log.js';

const fs = window.require('fs');
const path = window.require('path');
const os = window.require('os');
const { exec } = window.require('child_process');

const extensionDir = decodeURIComponent(path.dirname(window.location.pathname.replace(/^\//, '')));

// Bundled ffmpeg (vendored, librubberband-enabled) for pitch/reverse processing.
const FFMPEG_PATH = path.join(extensionDir, 'vendor', 'ffmpeg', 'ffmpeg.exe');

let audioContext = null;
const waveformCache = new Map(); // Cache waveform data by path

/**
 * Generate waveform data from audio file
 */
async function generateWaveform(audioPath, numBars = 50) {
    // Check cache first
    if (waveformCache.has(audioPath)) {
        return waveformCache.get(audioPath);
    }

    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Read file
        const buffer = fs.readFileSync(audioPath);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

        // Decode audio
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);

        // Calculate bars
        const samplesPerBar = Math.floor(channelData.length / numBars);
        const rawBars = [];
        let maxBar = 0;

        for (let i = 0; i < numBars; i++) {
            let sum = 0;
            const start = i * samplesPerBar;
            for (let j = 0; j < samplesPerBar; j++) {
                sum += Math.abs(channelData[start + j] || 0);
            }
            const avg = sum / samplesPerBar;
            rawBars.push(avg);
            if (avg > maxBar) maxBar = avg;
        }

        // Normalize
        const bars = rawBars.map(b => {
            const normalized = maxBar > 0 ? b / maxBar : 0;
            return Math.min(1, Math.max(0.04, normalized)); // Minimum 4% height so silence is visible but flat
        });

        // Cache result
        const result = { bars, duration: audioBuffer.duration };
        waveformCache.set(audioPath, result);
        return result;
    } catch (err) {
        console.error('[VT] Waveform generation failed:', err);
        // Return fallback random bars
        return {
            bars: Array.from({ length: numBars }, () => 0.2 + Math.random() * 0.6),
            duration: 0
        };
    }
}

/**
 * Load audio buffer for playback (separate from visualization)
 */
async function loadAudioBuffer(audioPath) {
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        const buffer = fs.readFileSync(audioPath);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        return await audioContext.decodeAudioData(arrayBuffer);
    } catch (err) {
        console.error('[VT] Audio buffer load failed:', err);
        return null;
    }
}

/**
 * Audio Preview Bar Module
 */
const AudioPreview = {
    el: null,
    canvas: null,
    ctx: null,
    audioCtx: null,
    audioBuffer: null,
    source: null,

    asset: null,
    isPlaying: false,
    waveformData: null,

    // Playback state
    playbackStartTime: 0,
    lastPausePosition: 0,

    volume: 0.8,
    pitch: 1.0,
    gainNode: null,

    processedAudioPath: null,
    ffmpegTimeout: null,

    init: function () {
        this.el = document.getElementById('audioPreviewBar');
        this.canvas = document.getElementById('audioTimelineCanvas');
        this.nameEl = document.getElementById('audioPreviewName');
        this.closeBtn = document.getElementById('audioPreviewClose');
        this.playBtn = document.getElementById('audioPlayBtn');
        this.replayBtn = document.getElementById('audioReplayBtn');
        this.volumeSlider = document.getElementById('audioVolumeSlider');
        this.pitchSlider = document.getElementById('audioPitchSlider');
        this.pitchValue = document.getElementById('audioPitchValue');
        this.pitchReset = document.getElementById('audioPitchReset');
        this.reverseCheck = document.getElementById('audioReverseCheck');
        this.timeCurrent = document.getElementById('audioCurrentTime');
        this.timeTotal = document.getElementById('audioTotalTime');

        if (!this.el) return;

        this.playIcon = this.playBtn.querySelector('.play-icon');
        this.pauseIcon = this.playBtn.querySelector('.pause-icon');
        this.ctx = this.canvas.getContext('2d');

        // Resize canvas on window resize
        window.addEventListener('resize', () => {
            if (this.el.classList.contains('visible')) {
                this.resizeCanvas();
                this.draw();
            }
        });

        this.setupListeners();
    },

    setupListeners: function () {
        // Close
        this.closeBtn.onclick = () => this.hide();

        // Play/Pause
        this.playBtn.onclick = () => this.togglePlay();

        // Replay
        if (this.replayBtn) {
            this.replayBtn.onclick = () => {
                this.seek(0);
                if (!this.isPlaying) {
                    this.play();
                }
            };
        }

        // Volume
        this.volumeSlider.oninput = (e) => {
            this.volume = parseFloat(e.target.value);
            if (this.gainNode) {
                // Smooth transition to avoid pops
                this.gainNode.gain.setTargetAtTime(this.volume, this.audioCtx.currentTime, 0.01);
            }
        };

        // Pitch
        this.pitchSlider.oninput = (e) => {
            this.pitch = parseFloat(e.target.value);
            if (this.pitchValue) this.pitchValue.textContent = this.pitch.toFixed(1) + 'x';
            this.updateAudioSettings();
            this.scheduleFFmpegProcessing();
        };
        this.pitchReset.onclick = () => {
            this.pitch = 1.0;
            this.pitchSlider.value = 1.0;
            if (this.pitchValue) this.pitchValue.textContent = '1.0x';
            this.updateAudioSettings();
            this.scheduleFFmpegProcessing();
        };

        // Reverse checkbox
        if (this.reverseCheck) {
            this.reverseCheck.onchange = () => {
                this.updateAudioSettings();
                this.scheduleFFmpegProcessing();
            };
        }

        // Timeline scrubbing
        this.isDragging = false;

        const handleSeek = (e) => {
            if (!this.waveformData) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, x / rect.width));
            this.seek(ratio);
        };

        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.wasPlaying = this.isPlaying;
            if (this.isPlaying) this.pause();
            handleSeek(e);
        });

        window.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                handleSeek(e);
            }
        });

        window.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.isDragging = false;
                if (this.wasPlaying) this.play();
            }
        });
    },

    resizeCanvas: function () {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
    },

    show: async function (asset) {
        if (this.asset && this.asset.id === asset.id && this.el.classList.contains('visible')) {
            return;
        }

        this.asset = asset;
        this.nameEl.textContent = asset.name;
        this.nameEl.title = asset.name;

        // Reset state
        this.stop();
        this.waveformData = null;
        this.audioBuffer = null;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Show UI
        this.el.classList.remove('hidden');
        this.el.style.display = 'flex';
        requestAnimationFrame(() => {
            this.el.classList.add('visible');
            this.resizeCanvas();
        });

        // Initialize Audio Content
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Load Audio Buffer
        // We use a separate local load because generateWaveform might be cached without buffer.
        this.audioBuffer = await loadAudioBuffer(asset.path);

        // Set initial pitch UI
        if (this.pitchValue) this.pitchValue.textContent = this.pitch.toFixed(1) + 'x';
        this.updateTimeDisplay();

        // Generate Waveform
        this.waveformData = await generateWaveform(asset.path, 200);
        this.draw();
    },

    hide: function () {
        this.stop();
        this.el.classList.remove('visible');
        setTimeout(() => {
            this.el.classList.add('hidden');
            this.el.style.display = 'none';
        }, 300);
    },

    stop: function () {
        if (this.source) {
            try { this.source.stop(); } catch (e) { }
            this.source = null;
        }
        this.isPlaying = false;
        this.playbackStartTime = 0;
        this.lastPausePosition = 0;
        this.updatePlayBtn();
        this.stopAnimationLoop();
        this.draw();
        this.updateTimeDisplay();
    },

    togglePlay: function () {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    },
    play: function () {
        if (!this.audioCtx || !this.audioBuffer) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

        // Check reverse state
        const isReversed = this.reverseCheck ? this.reverseCheck.checked : false;

        // Create source
        this.source = this.audioCtx.createBufferSource();

        // If reversed, create a reversed copy of the buffer
        if (isReversed) {
            if (!this._reversedBuffer || this._reversedBufferSource !== this.audioBuffer) {
                // Create reversed buffer (cache it)
                const numChannels = this.audioBuffer.numberOfChannels;
                const length = this.audioBuffer.length;
                this._reversedBuffer = this.audioCtx.createBuffer(
                    numChannels, length, this.audioBuffer.sampleRate
                );
                for (let ch = 0; ch < numChannels; ch++) {
                    const srcData = this.audioBuffer.getChannelData(ch);
                    const dstData = this._reversedBuffer.getChannelData(ch);
                    for (let i = 0; i < length; i++) {
                        dstData[i] = srcData[length - 1 - i];
                    }
                }
                this._reversedBufferSource = this.audioBuffer;
            }
            this.source.buffer = this._reversedBuffer;
        } else {
            this.source.buffer = this.audioBuffer;
        }
        this.source.playbackRate.value = 1.0;

        // Create GainNode if needed
        if (!this.gainNode) {
            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.value = this.volume;
            this.gainNode.connect(this.audioCtx.destination);
        }

        // Create Jungle pitch shifter if needed
        if (!this.jungle) {
            this.jungle = new Jungle(this.audioCtx);
            this.jungle.output.connect(this.gainNode);
        }

        // Connect source to jungle
        this.source.connect(this.jungle.input);
        
        // Calculate pitch multiplier for Jungle
        this.jungle.setPitchOffset(Math.log2(this.pitch));

        // Calculate start time
        if (this.lastPausePosition >= this.audioBuffer.duration) {
            this.lastPausePosition = 0;
        }

        // For reversed playback, mirror the offset
        let offset;
        if (isReversed) {
            offset = this.audioBuffer.duration - this.lastPausePosition;
            if (offset >= this.audioBuffer.duration) offset = 0;
            if (offset < 0) offset = 0;
        } else {
            offset = this.lastPausePosition;
        }

        this.playbackStartTime = this.audioCtx.currentTime - offset;
        this._isReversedPlayback = isReversed;

        this.source.start(0, offset);
        this.isPlaying = true;

        this.source.onended = () => {
            if (this.isPlaying) {
                const elapsed = (this.audioCtx.currentTime - this.playbackStartTime);
                if (elapsed >= this.audioBuffer.duration - 0.1) {
                    this.isPlaying = false;
                    this.lastPausePosition = 0;
                    this.updatePlayBtn();
                    this.stopAnimationLoop();
                    this.draw();
                }
            }
        };

        this.updatePlayBtn();
        this.startAnimationLoop();
    },

    pause: function () {
        if (this.source) {
            try { this.source.stop(); } catch (e) { }
            this.source = null;
        }

        if (this.audioBuffer) {
            const elapsed = (this.audioCtx.currentTime - this.playbackStartTime);
            if (this._isReversedPlayback) {
                // Convert reversed elapsed back to forward position
                this.lastPausePosition = this.audioBuffer.duration - elapsed;
            } else {
                this.lastPausePosition = elapsed;
            }
            this.lastPausePosition = Math.max(0, Math.min(this.lastPausePosition, this.audioBuffer.duration));
        }

        this.isPlaying = false;
        this.updatePlayBtn();
        this.stopAnimationLoop();
    },

    seek: function (ratio) {
        if (!this.audioBuffer) return;

        const newTime = ratio * this.audioBuffer.duration;
        this.lastPausePosition = newTime;

        if (this.isPlaying) {
            if (this.source) {
                try { this.source.stop(); } catch (e) { }
            }
            this.play();
        } else {
            this.draw();
            this.updateTimeDisplay();
        }
    },

    startAnimationLoop: function () {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        const loop = () => {
            if (this.isPlaying) {
                this.draw();
                this.updateTimeDisplay();
                this.animationId = requestAnimationFrame(loop);
            }
        };
        this.animationId = requestAnimationFrame(loop);
    },

    stopAnimationLoop: function () {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    },

    updateAudioSettings: function () {
        if (this.isPlaying) {
            // Save current position before restarting
            const elapsed = (this.audioCtx.currentTime - this.playbackStartTime);
            if (this._isReversedPlayback) {
                this.lastPausePosition = this.audioBuffer.duration - elapsed;
            } else {
                this.lastPausePosition = elapsed;
            }
            this.lastPausePosition = Math.max(0, Math.min(this.lastPausePosition, this.audioBuffer.duration));

            if (this.source) {
                try { this.source.stop(); } catch (e) { }
            }
            // Invalidate reversed buffer cache when reverse state changes
            this._reversedBuffer = null;
            this.play();
        } else {
            // Invalidate cache even when paused
            this._reversedBuffer = null;
        }
    },

    updatePlayBtn: function () {
        if (this.isPlaying) {
            this.playIcon.style.display = 'none';
            this.pauseIcon.style.display = '';
        } else {
            this.playIcon.style.display = '';
            this.pauseIcon.style.display = 'none';
        }
    },

    updateTimeDisplay: function () {
        let current = 0;
        let total = 0;

        if (this.audioBuffer) {
            total = this.audioBuffer.duration;
            if (this.isPlaying) {
                const elapsed = (this.audioCtx.currentTime - this.playbackStartTime);
                if (this._isReversedPlayback) {
                    current = this.audioBuffer.duration - elapsed;
                } else {
                    current = elapsed;
                }
            } else {
                current = this.lastPausePosition;
            }
            current = Math.max(0, Math.min(current, total));
        }

        const format = (sec) => {
            if (!isFinite(sec)) return "00:00.00";
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            const ms = Math.floor((sec % 1) * 100);
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
        };

        if (this.timeCurrent) this.timeCurrent.textContent = format(current);
        if (this.timeTotal) this.timeTotal.textContent = format(total);
    },

    draw: function () {
        if (!this.waveformData || !this.waveformData.bars) return;

        const { bars } = this.waveformData;
        const width = this.canvas.width;
        const height = this.canvas.height;

        this.ctx.clearRect(0, 0, width, height);

        // Calculate current play position for display
        let playPosition = 0;
        if (this.audioBuffer && this.audioBuffer.duration > 0) {
            if (this.isPlaying) {
                const elapsed = (this.audioCtx.currentTime - this.playbackStartTime);
                if (this._isReversedPlayback) {
                    playPosition = (this.audioBuffer.duration - elapsed) / this.audioBuffer.duration;
                } else {
                    playPosition = elapsed / this.audioBuffer.duration;
                }
            } else {
                playPosition = this.lastPausePosition / this.audioBuffer.duration;
            }
        }
        this.playPosition = Math.max(0, Math.min(playPosition, 1));
        const curPos = this.playPosition;

        // Colors matching panel UI but brighter for contrast
        const accentColor = '#818cf8';
        const unplayedColor = 'rgba(255, 255, 255, 0.2)';

        // Total width per bar including gap
        const totalBarWidth = width / bars.length;
        const barWidth = Math.max(1.5, totalBarWidth * 0.6); // 60% bar, 40% gap

        this.ctx.lineCap = 'round';
        this.ctx.lineWidth = barWidth;

        bars.forEach((bar, i) => {
            // Scale bar height to max 80% of canvas height
            let barHeight = Math.max(2, bar * height * 0.8);
            const x = (i * totalBarWidth) + (totalBarWidth / 2);
            const centerY = height / 2;
            const startY = centerY - (barHeight / 2);
            const endY = centerY + (barHeight / 2);

            this.ctx.beginPath();
            this.ctx.moveTo(x, startY);
            this.ctx.lineTo(x, endY);

            const barPos = i / bars.length;
            if (barPos <= curPos) {
                this.ctx.strokeStyle = accentColor;
                this.ctx.shadowColor = accentColor;
                this.ctx.shadowBlur = 2;
            } else {
                this.ctx.strokeStyle = unplayedColor;
                this.ctx.shadowColor = 'transparent';
                this.ctx.shadowBlur = 0;
            }
            this.ctx.stroke();
        });

        // Draw playhead smoothly
        this.ctx.shadowColor = 'transparent';
        this.ctx.shadowBlur = 0;
        if (curPos > 0) {
            const playX = curPos * width;
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(playX, 0, 2, height);
        }
    },

    scheduleFFmpegProcessing: function() {
        if (this.ffmpegTimeout) clearTimeout(this.ffmpegTimeout);
        
        // Kill previous process if it's still running
        if (this.ffmpegProcess) {
            try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) {}
            this.ffmpegProcess = null;
        }

        // Delete the previously processed file so they don't pile up during a session
        if (this.processedAudioPath) {
            try { fs.unlinkSync(this.processedAudioPath); } catch (e) {}
        }
        this.processedAudioPath = null;
        
        if (this.pitch === 1.0 && (!this.reverseCheck || !this.reverseCheck.checked)) {
            this.isProcessing = false;
            this.processingPromise = Promise.resolve(null);
            return; // No processing needed
        }

        this.isProcessing = true;
        let resolvePromise;
        this.processingPromise = new Promise((resolve) => { resolvePromise = resolve; });

        this.ffmpegTimeout = setTimeout(() => {
            if (!this.asset) {
                this.isProcessing = false;
                resolvePromise(null);
                return;
            }
            const ffmpegExe = FFMPEG_PATH;
            if (!fs.existsSync(ffmpegExe)) {
                addLog('ERROR: ffmpeg not found at ' + ffmpegExe + ' - pitch/reverse disabled. Restore vendor/ffmpeg/ffmpeg.exe.', 'error');
                this.isProcessing = false;
                resolvePromise(null);
                return;
            }
            const tempDir = path.join(os.homedir(), 'AppData', 'Roaming', 'VibeTools', 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const tempPath = path.join(tempDir, 'ffmpeg_' + Date.now() + '.wav');
            
            let filters = [];
            if (this.reverseCheck && this.reverseCheck.checked) {
                filters.push('areverse');
            }
            if (this.pitch !== 1.0) {
                // Use rubberband for mathematically perfect pitch shift without tempo change
                filters.push(`rubberband=pitch=${this.pitch}`);
            }
            
            const filterStr = filters.length > 0 ? `-af "${filters.join(',')}"` : '';
            let cmd = `"${ffmpegExe}" -y -i "${this.asset.path}" ${filterStr} "${tempPath}"`;

            addLog('Running FFmpeg: ' + cmd, 'info');
            this.ffmpegProcess = exec(cmd, (err) => {
                this.isProcessing = false;
                this.ffmpegProcess = null;
                if (err) {
                    if (err.killed) {
                        addLog('FFmpeg killed (slider moved)', 'info');
                    } else {
                        addLog('FFmpeg error: ' + err, 'error');
                    }
                    resolvePromise(null);
                } else {
                    addLog('FFmpeg complete: ' + tempPath, 'info');
                    this.processedAudioPath = tempPath;
                    resolvePromise(tempPath);
                }
            });
        }, 300); // 300ms debounce
    }
};

/**
* Setup static waveform for asset card
*/
function setupStaticWaveform(canvas, waveformData) {
    const ctx = canvas.getContext('2d');

    function drawWaveform() {
        const { bars } = waveformData;
        const width = canvas.width;
        const height = canvas.height;
        const slot = width / bars.length;
        const barWidth = Math.max(1.0, slot * 0.45);

        ctx.clearRect(0, 0, width, height);

        // Confine the waveform to the upper band, clear of the title overlay.
        const topPad = height * 0.15;
        const bottomLimit = height * 0.50;
        const centerY = (topPad + bottomLimit) / 2;
        const maxHalf = (bottomLimit - topPad) / 2;

        // Vertical gradient: brighter in the middle, deeper at the edges
        const grad = ctx.createLinearGradient(0, topPad, 0, bottomLimit);
        grad.addColorStop(0, '#6366f1');
        grad.addColorStop(0.5, '#a5b4fc');
        grad.addColorStop(1, '#6366f1');
        ctx.fillStyle = grad;

        bars.forEach((bar, i) => {
            const barHeight = Math.max(3, bar * maxHalf * 2);
            const x = (i * slot) + (slot - barWidth) / 2;
            roundedBar(ctx, x, centerY - barHeight / 2, barWidth, barHeight, barWidth / 2);
        });
    }

    // Rounded vertical bar drawn as a manual path (CEP's CEF may predate ctx.roundRect)
    function roundedBar(c, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
        c.fill();
    }

    // Draw once
    drawWaveform();
}

export { AudioPreview, generateWaveform, setupStaticWaveform };
