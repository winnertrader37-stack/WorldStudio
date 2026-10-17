"use strict";

/* ============================================================
   NAOL MUSIC STUDIO 3D
   Browser-based multitrack audio editor
   File: script.js
   ============================================================ */

(() => {
    "use strict";

    /* ========================================================
       1. DOM HELPERS
       ======================================================== */

    const $ = (id) => document.getElementById(id);

    const $$ = (selector, root = document) =>
        Array.from(root.querySelectorAll(selector));

    const state = {
        audioContext: null,
        masterGain: null,
        masterAnalyser: null,

        music: null,
        voice: null,
        keyboard: null,

        selectedTrack: "music",

        playing: false,
        paused: false,
        starting: false,

        startedAt: 0,
        pausedAt: 0,
        playPosition: 0,

        duration: 0,
        trimStart: 0,
        trimEnd: null,

        zoom: 1,

        mediaSources: new WeakMap(),
        audioElements: new Set(),

        recording: {
            recorder: null,
            stream: null,
            chunks: [],
            blob: null,
            url: null,
            paused: false,
            startedAt: 0,
            elapsedBeforePause: 0,
            timer: null,
            analyser: null,
            animation: 0,
            source: null,
            monitorGain: null
        },

        keyboardRecording: {
            recording: false,
            paused: false,
            startedAt: 0,
            pausedAt: 0,
            events: [],
            activeNotes: new Map(),
            audioBuffer: null,
            blob: null,
            url: null
        },

        settings: {
            volume: 100,
            bass: 0,
            mid: 0,
            treble: 0,
            pan: 0,
            reverb: 0,
            delay: 0,
            distortion: 0,
            fadeIn: 0,
            fadeOut: 0,
            masterVolume: 100,
            musicVolume: 100,
            voiceVolume: 100,
            keyboardVolume: 100,
            musicPan: 0,
            voicePan: 0,
            keyboardPan: 0,
            monitoring: 0,
            speed: 1,
            mute: false,
            bypass: false
        },

        undoStack: [],
        redoStack: [],

        exportBlob: null,
        exportUrl: null,
        exporting: false,

        toastTimer: null,
        animationFrame: 0,

        splitMarkers: [],

        projectName: "Naol Music Project",

        soloTrack: null
    };

    /* ========================================================
       2. TRACK STRUCTURE
       ======================================================== */

    function createTrack(type, label) {
        return {
            type,
            label,

            file: null,
            blob: null,
            url: null,

            element: null,
            source: null,

            inputGain: null,
            bassFilter: null,
            midFilter: null,
            trebleFilter: null,

            distortion: null,
            reverb: null,
            reverbGain: null,
            dryGain: null,

            delay: null,
            delayFeedback: null,
            delayGain: null,

            panner: null,
            analyser: null,
            outputGain: null,

            buffer: null,

            duration: 0,
            offset: 0,

            muted: false,
            solo: false,

            volume: 100,
            pan: 0,

            connected: false,
            name: label,

            mediaSourceCreated: false
        };
    }

    state.music = createTrack("music", "Main Music");
    state.voice = createTrack("voice", "Voice Recording");
    state.keyboard = createTrack("keyboard", "Keyboard Recording");

    /* ========================================================
       3. GENERAL UTILITIES
       ======================================================== */

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function numberValue(id, fallback = 0) {
        const element = $(id);

        if (!element) {
            return fallback;
        }

        const value = Number(element.value);

        return Number.isFinite(value) ? value : fallback;
    }

    function formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) {
            seconds = 0;
        }

        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);

        return (
            String(mins).padStart(2, "0") +
            ":" +
            String(secs).padStart(2, "0")
        );
    }

    function formatLongTime(seconds) {
        if (!Number.isFinite(seconds)) {
            return "00:00";
        }

        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);

        return (
            String(mins).padStart(2, "0") +
            ":" +
            String(secs).padStart(2, "0")
        );
    }

    function safeText(id, text) {
        const element = $(id);

        if (element) {
            element.textContent = String(text);
        }
    }

    function setStatus(id, text) {
        safeText(id, text);
    }

    function toast(message, type = "info") {
        const element = $("toast");

        if (!element) {
            console.log("[Naol Studio]", message);
            return;
        }

        element.textContent = message;
        element.className = "";

        element.classList.add("show");

        if (type === "error") {
            element.classList.add("error");
        }

        if (type === "success") {
            element.classList.add("success");
        }

        clearTimeout(state.toastTimer);

        state.toastTimer = setTimeout(() => {
            element.classList.remove(
                "show",
                "visible",
                "error",
                "success"
            );
        }, 3500);
    }

    function getTrack(type) {
        return state[type] || null;
    }

    function getAudioContextConstructor() {
        return (
            window.AudioContext ||
            window.webkitAudioContext ||
            null
        );
    }

    /* ========================================================
       4. AUDIO CONTEXT
       ======================================================== */

    async function ensureAudioContext() {
        if (!state.audioContext) {
            const AudioContextClass =
                getAudioContextConstructor();

            if (!AudioContextClass) {
                throw new Error(
                    "Browser kee Web Audio API hin deeggaru."
                );
            }

            state.audioContext = new AudioContextClass();

            const ctx = state.audioContext;

            state.masterGain = ctx.createGain();
            state.masterAnalyser = ctx.createAnalyser();

            state.masterAnalyser.fftSize = 2048;
            state.masterAnalyser.smoothingTimeConstant = 0.82;

            state.masterGain.gain.value =
                state.settings.masterVolume / 100;

            state.masterGain.connect(state.masterAnalyser);
            state.masterAnalyser.connect(ctx.destination);

            updateMasterVolume();
        }

        if (state.audioContext.state === "suspended") {
            await state.audioContext.resume();
        }

        return state.audioContext;
    }

    /* ========================================================
       5. CREATE AUDIO ELEMENT
       ======================================================== */

    function createAudioElement(track) {
        if (track.element) {
            return track.element;
        }

        const audio = document.createElement("audio");

        audio.preload = "metadata";
        audio.crossOrigin = "anonymous";
        audio.controls = false;

        audio.volume = 1;
        audio.playbackRate = state.settings.speed;

        audio.style.display = "none";

        document.body.appendChild(audio);

        track.element = audio;

        state.audioElements.add(audio);

        audio.addEventListener("loadedmetadata", () => {
            track.duration = Number.isFinite(audio.duration)
                ? audio.duration
                : 0;

            if (track.type === "music") {
                state.duration = track.duration;

                if (
                    state.trimEnd === null ||
                    state.trimEnd > state.duration
                ) {
                    state.trimEnd = state.duration;
                }

                updateDurationDisplays();
                drawTimeline();
            }
        });

        audio.addEventListener("ended", () => {
            if (track.type === "music") {
                stopPlayback(false);
            }
        });

        audio.addEventListener("error", () => {
            console.error(
                "Audio playback error:",
                track.name,
                audio.error
            );

            if (track.type === "music") {
                toast(
                    "Music playback hin milkoofne. Faayila biraa yaali.",
                    "error"
                );
            }
        });

        return audio;
    }

    /* ========================================================
       6. BUILD AUDIO GRAPH
       ======================================================== */

    async function ensureTrackGraph(track) {
        const ctx = await ensureAudioContext();

        const audio = createAudioElement(track);

        if (track.connected) {
            return track;
        }

        let source = state.mediaSources.get(audio);

        if (!source) {
            source = ctx.createMediaElementSource(audio);

            state.mediaSources.set(audio, source);
        }

        track.source = source;

        track.inputGain = ctx.createGain();

        track.bassFilter = ctx.createBiquadFilter();
        track.bassFilter.type = "lowshelf";
        track.bassFilter.frequency.value = 120;

        track.midFilter = ctx.createBiquadFilter();
        track.midFilter.type = "peaking";
        track.midFilter.frequency.value = 1000;
        track.midFilter.Q.value = 0.8;

        track.trebleFilter = ctx.createBiquadFilter();
        track.trebleFilter.type = "highshelf";
        track.trebleFilter.frequency.value = 7000;

        track.distortion = ctx.createWaveShaper();
        track.distortion.oversample = "4x";

        track.reverb = ctx.createConvolver();

        track.reverbGain = ctx.createGain();
        track.dryGain = ctx.createGain();

        track.delay = ctx.createDelay(2.0);
        track.delayFeedback = ctx.createGain();
        track.delayGain = ctx.createGain();

        track.panner =
            typeof ctx.createStereoPanner === "function"
                ? ctx.createStereoPanner()
                : ctx.createGain();

        track.analyser = ctx.createAnalyser();
        track.analyser.fftSize = 2048;

        track.outputGain = ctx.createGain();

        track.source.connect(track.inputGain);

        track.inputGain.connect(track.bassFilter);
        track.bassFilter.connect(track.midFilter);
        track.midFilter.connect(track.trebleFilter);

        track.trebleFilter.connect(track.distortion);

        track.distortion.connect(track.dryGain);
        track.dryGain.connect(track.panner);

        track.distortion.connect(track.reverb);
        track.reverb.connect(track.reverbGain);
        track.reverbGain.connect(track.panner);

        track.distortion.connect(track.delay);
        track.delay.connect(track.delayGain);
        track.delayGain.connect(track.delayFeedback);
        track.delayFeedback.connect(track.delay);

        track.delayGain.connect(track.panner);

        track.panner.connect(track.analyser);
        track.analyser.connect(track.outputGain);

        track.outputGain.connect(state.masterGain);

        track.connected = true;

        buildReverbImpulse(track);

        applyTrackSettings(track);

        return track;
    }

    /* ========================================================
       7. DISTORTION CURVE
       ======================================================== */

    function makeDistortionCurve(amount) {
        const strength = clamp(Number(amount) || 0, 0, 100);

        if (strength <= 0) {
            return null;
        }

        const samples = 44100;
        const curve = new Float32Array(samples);

        const k = strength * 1.5;

        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;

            curve[i] =
                ((3 + k) * x * 20 * Math.PI / 180) /
                (
                    Math.PI +
                    k * Math.abs(x)
                );
        }

        return curve;
    }

    /* ========================================================
       8. REVERB IMPULSE
       ======================================================== */

    function buildReverbImpulse(track) {
        if (!state.audioContext || !track.reverb) {
            return;
        }

        const ctx = state.audioContext;

        const duration = 2.2;
        const rate = ctx.sampleRate;

        const length = Math.floor(rate * duration);

        const impulse = ctx.createBuffer(
            2,
            length,
            rate
        );

        for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);

            for (let i = 0; i < length; i++) {
                const fade = 1 - i / length;

                data[i] =
                    (Math.random() * 2 - 1) *
                    fade *
                    fade;
            }
        }

        track.reverb.buffer = impulse;
    }

    /* ========================================================
       9. LIVE SETTINGS
       ======================================================== */

    function applyTrackSettings(track) {
        if (!track.connected) {
            return;
        }

        const ctx = state.audioContext;

        const now = ctx.currentTime;

        const isMusic = track.type === "music";

        const volume = isMusic
            ? state.settings.volume
            : track.volume;

        const mute =
            track.muted ||
            state.settings.mute ||
            (
                state.soloTrack &&
                state.soloTrack !== track.type
            );

        const pan = isMusic
            ? state.settings.pan
            : track.pan;

        track.inputGain.gain.setTargetAtTime(
            1,
            now,
            0.015
        );

        track.bassFilter.gain.setTargetAtTime(
            isMusic && !state.settings.bypass
                ? state.settings.bass
                : 0,
            now,
            0.02
        );

        track.midFilter.gain.setTargetAtTime(
            isMusic && !state.settings.bypass
                ? state.settings.mid
                : 0,
            now,
            0.02
        );

        track.trebleFilter.gain.setTargetAtTime(
            isMusic && !state.settings.bypass
                ? state.settings.treble
                : 0,
            now,
            0.02
        );

        const distortionAmount =
            isMusic && !state.settings.bypass
                ? state.settings.distortion
                : 0;

        track.distortion.curve =
            makeDistortionCurve(distortionAmount);

        track.distortion.oversample = "4x";

        const reverbAmount =
            isMusic && !state.settings.bypass
                ? state.settings.reverb / 100
                : 0;

        track.dryGain.gain.setTargetAtTime(
            1 - reverbAmount * 0.45,
            now,
            0.02
        );

        track.reverbGain.gain.setTargetAtTime(
            reverbAmount,
            now,
            0.02
        );

        const delayAmount =
            isMusic && !state.settings.bypass
                ? state.settings.delay / 100
                : 0;

        track.delay.delayTime.setTargetAtTime(
            0.25,
            now,
            0.02
        );

        track.delayGain.gain.setTargetAtTime(
            delayAmount * 0.45,
            now,
            0.02
        );

        track.delayFeedback.gain.setTargetAtTime(
            Math.min(0.65, delayAmount * 0.6),
            now,
            0.02
        );

        if (track.panner.pan) {
            track.panner.pan.setTargetAtTime(
                clamp(pan / 100, -1, 1),
                now,
                0.02
            );
        }

        const trackVolume = clamp(volume / 100, 0, 2);

        track.outputGain.gain.setTargetAtTime(
            mute ? 0 : trackVolume,
            now,
            0.02
        );

        if (track.element) {
            track.element.playbackRate =
                state.settings.speed;
        }
    }

    function applyAllTrackSettings() {
        [
            state.music,
            state.voice,
            state.keyboard
        ].forEach((track) => {
            applyTrackSettings(track);
        });

        updateMasterVolume();
    }

    function updateMasterVolume() {
        if (!state.masterGain || !state.audioContext) {
            return;
        }

        const value = clamp(
            state.settings.masterVolume / 100,
            0,
            1.5
        );

        state.masterGain.gain.setTargetAtTime(
            value,
            state.audioContext.currentTime,
            0.02
        );

        safeText(
            "masterLevelText",
            Math.round(value * 100) + "%"
        );
    }

    /* ========================================================
       10. DECODE AUDIO
       ======================================================== */

    async function decodeBlob(blob) {
        const ctx = await ensureAudioContext();

        const arrayBuffer = await blob.arrayBuffer();

        return await ctx.decodeAudioData(arrayBuffer);
    }

    /* ========================================================
       11. IMPORT MUSIC
       ======================================================== */

    async function loadMusicFile(file) {
        if (!file) {
            return;
        }

        if (
            file.type &&
            !file.type.startsWith("audio/") &&
            !/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name)
        ) {
            toast(
                "Faayila audio filadhu. Music file qofatu deeggarama.",
                "error"
            );
            return;
        }

        stopPlayback(false);

        const track = state.music;

        revokeTrackURL(track);

        track.file = file;
        track.blob = file;
        track.name = file.name;
        track.volume = 100;
        track.pan = 0;
        track.muted = false;

        track.url = URL.createObjectURL(file);

        const audio = createAudioElement(track);

        audio.src = track.url;
        audio.load();

        safeText("currentTrackTitle", file.name);
        safeText("audioFormat", file.type || "Audio file");
        safeText("playbackBadge", "Ready");

        setStatus("audioStatus", "Music loaded");
        setStatus("engineStatus", "Audio ready");

        safeText("timelineTrackName", file.name);

        state.selectedTrack = "music";

        state.trimStart = 0;
        state.trimEnd = null;
        state.playPosition = 0;

        state.duration = 0;
        track.duration = 0;
        track.buffer = null;

        updateDurationDisplays();
        updateProjectState();

        toast("Music fe'ameera. Playback jalqabuuf Play tuqi.", "success");

        drawTimeline();
        renderTrackList();

        try {
            await ensureTrackGraph(track);

            track.buffer = await decodeBlob(file);

            track.duration = track.buffer.duration;
            state.duration = track.duration;

            if (state.trimEnd === null) {
                state.trimEnd = state.duration;
            }

            updateDurationDisplays();
            drawWaveform(track.buffer);
            drawTimeline();
        } catch (error) {
            console.warn("Audio decode:", error);

            setStatus(
                "audioStatus",
                "Music loaded; analysis unavailable"
            );
        }

        refreshAnalysisLabels();
    }

    function revokeTrackURL(track) {
        if (track.url) {
            URL.revokeObjectURL(track.url);
            track.url = null;
        }
    }

    /* ========================================================
       12. ADD AUDIO TO SECONDARY TRACK
       ======================================================== */

    async function loadSecondaryTrack(type, blob, name) {
        const track = getTrack(type);

        if (!track || type === "music") {
            return;
        }

        stopPlayback(false);

        revokeTrackURL(track);

        track.blob = blob;
        track.file = blob;
        track.name = name || track.label;
        track.url = URL.createObjectURL(blob);

        const audio = createAudioElement(track);

        audio.src = track.url;
        audio.load();

        track.volume = 100;
        track.pan = 0;
        track.muted = false;

        track.buffer = null;
        track.duration = 0;

        try {
            await ensureTrackGraph(track);

            track.buffer = await decodeBlob(blob);
            track.duration = track.buffer.duration;
        } catch (error) {
            console.warn(
                "Secondary audio decode failed:",
                error
            );
        }

        applyTrackSettings(track);

        renderTrackList();
        drawTimeline();

        updateProjectState();

        toast(
            track.label + " timeline irratti dabalame.",
            "success"
        );
    }

    /* ========================================================
       13. TRANSPORT: PLAY
       ======================================================== */

    async function playPlayback() {
        if (!state.music.blob || !state.music.element) {
            toast(
                "Jalqaba music upload godhi.",
                "error"
            );
            return;
        }

        if (state.starting) {
            return;
        }

        if (state.playing && !state.paused) {
            pausePlayback();
            return;
        }

        state.starting = true;

        try {
            await ensureAudioContext();

            const tracks = [
                state.music,
                state.voice,
                state.keyboard
            ];

            for (const track of tracks) {
                if (track.blob) {
                    await ensureTrackGraph(track);
                }
            }

            applyAllTrackSettings();

            const startPosition = state.paused
                ? state.playPosition
                : Math.max(
                    state.trimStart,
                    state.playPosition
                );

            if (
                state.trimEnd !== null &&
                startPosition >= state.trimEnd
            ) {
                state.playPosition = state.trimStart;
            }

            const position = state.playPosition;

            for (const track of tracks) {
                if (!track.element || !track.blob) {
                    continue;
                }

                const audio = track.element;

                const safePosition = Math.min(
                    position,
                    Math.max(0, track.duration - 0.02)
                );

                try {
                    audio.currentTime = safePosition;
                } catch (_) {}

                audio.playbackRate = state.settings.speed;
            }

            const activePromises = tracks
                .filter((track) => {
                    if (!track.blob || !track.element) {
                        return false;
                    }

                    return !(
                        state.soloTrack &&
                        state.soloTrack !== track.type
                    );
                })
                .map((track) => track.element.play());

            await Promise.all(activePromises);

            state.playing = true;
            state.paused = false;
            state.startedAt = performance.now();

            safeText("playbackBadge", "Playing");
            setStatus("engineStatus", "Audio playing");

            updateTransportButtons();

            startPlaybackLoop();
        } catch (error) {
            console.error(error);

            toast(
                "Playback jalqabuu hin dandeenye. Play irra deebi'ii tuqi.",
                "error"
            );
        } finally {
            state.starting = false;
        }
    }

    /* ========================================================
       14. TRANSPORT: PAUSE
       ======================================================== */

    function pausePlayback() {
        if (!state.playing) {
            return;
        }

        const audio = state.music.element;

        if (audio) {
            state.playPosition = audio.currentTime;
        }

        [
            state.music,
            state.voice,
            state.keyboard
        ].forEach((track) => {
            if (track.element) {
                track.element.pause();
            }
        });

        state.playing = false;
        state.paused = true;

        safeText("playbackBadge", "Paused");

        updateTransportButtons();
        updatePlayhead();
    }

    /* ========================================================
       15. TRANSPORT: STOP
       ======================================================== */

    function stopPlayback(resetPosition = true) {
        [
            state.music,
            state.voice,
            state.keyboard
        ].forEach((track) => {
            if (!track.element) {
                return;
            }

            track.element.pause();

            if (resetPosition) {
                try {
                    track.element.currentTime = state.trimStart || 0;
                } catch (_) {}
            }
        });

        state.playing = false;
        state.paused = false;
        state.starting = false;

        if (resetPosition) {
            state.playPosition = state.trimStart || 0;
        } else if (state.music.element) {
            state.playPosition =
                state.music.element.currentTime || 0;
        }

        safeText("playbackBadge", "Stopped");

        updateTransportButtons();
        updatePlayhead();
    }

    /* ========================================================
       16. PLAYBACK LOOP
       ======================================================== */

    function startPlaybackLoop() {
        cancelAnimationFrame(state.animationFrame);

        const loop = () => {
            if (!state.playing) {
                return;
            }

            const audio = state.music.element;

            if (audio) {
                state.playPosition = audio.currentTime;

                const trimEnd = state.trimEnd;

                if (
                    trimEnd !== null &&
                    audio.currentTime >= trimEnd
                ) {
                    stopPlayback(false);

                    safeText("playbackBadge", "Finished");

                    return;
                }

                syncSecondaryTracks();
            }

            updatePlayhead();
            updateTimeDisplays();
            updateVisualizer();

            state.animationFrame =
                requestAnimationFrame(loop);
        };

        state.animationFrame =
            requestAnimationFrame(loop);
    }

    function syncSecondaryTracks() {
        const main = state.music.element;

        if (!main) {
            return;
        }

        [
            state.voice,
            state.keyboard
        ].forEach((track) => {
            if (!track.element || !track.blob) {
                return;
            }

            const secondary = track.element;

            const difference = Math.abs(
                secondary.currentTime - main.currentTime
            );

            if (difference > 0.15) {
                try {
                    secondary.currentTime = main.currentTime;
                } catch (_) {}
            }

            if (
                state.playing &&
                secondary.paused &&
                !(
                    state.soloTrack &&
                    state.soloTrack !== track.type
                )
            ) {
                secondary.play().catch(() => {});
            }
        });
    }

    function updateTransportButtons() {
        const play = $("playBtn");

        if (play) {
            play.textContent =
                state.playing && !state.paused
                    ? "Ⅱ Pause"
                    : "▶ Play";
        }

        const stop = $("stopBtn");

        if (stop) {
            stop.disabled = !(
                state.playing ||
                state.paused
            );
        }
    }

    /* ========================================================
       17. TIME DISPLAYS
       ======================================================== */

    function updateTimeDisplays() {
        safeText(
            "timeDisplay",
            formatTime(state.playPosition)
        );

        safeText(
            "durationDisplay",
            formatTime(state.duration)
        );

        const seek = $("seekBar");

        if (seek && state.duration > 0) {
            seek.value = String(
                (state.playPosition / state.duration) * 1000
            );
        }
    }

    function updateDurationDisplays() {
        safeText(
            "trackDurationText",
            formatTime(state.duration)
        );

        safeText(
            "durationDisplay",
            formatTime(state.duration)
        );

        safeText(
            "exportDuration",
            formatTime(
                Math.max(
                    0,
                    (state.trimEnd ?? state.duration) -
                    state.trimStart
                )
            )
        );
    }

    /* ========================================================
       18. SEEK
       ======================================================== */

    function seekTo(position) {
        if (!state.music.element || !state.duration) {
            return;
        }

        const end = state.trimEnd ?? state.duration;

        position = clamp(
            position,
            0,
            Math.max(0, state.duration)
        );

        state.playPosition = position;

        try {
            state.music.element.currentTime = position;
        } catch (_) {}

        [
            state.voice,
            state.keyboard
        ].forEach((track) => {
            if (track.element && track.blob) {
                try {
                    track.element.currentTime = Math.min(
                        position,
                        Math.max(0, track.duration - 0.02)
                    );
                } catch (_) {}
            }
        });

        if (position >= end && state.playing) {
            stopPlayback(false);
        }

        updatePlayhead();
        updateTimeDisplays();
    }

    /* ========================================================
       19. TIMELINE AND PLAYHEAD
       ======================================================== */

    function drawTimeline() {
        const content = $("timelineContent");

        if (!content) {
            return;
        }

        const baseWidth = Math.max(
            600,
            Math.max(state.duration, 60) *
            12 *
            state.zoom
        );

        content.style.width = baseWidth + "px";

        const ruler = $("timelineRuler");

        if (ruler) {
            ruler.style.width = baseWidth + "px";
        }

        const mainClip = $("mainAudioClip");

        if (mainClip) {
            mainClip.style.width = "100%";
            mainClip.style.position = "relative";
        }

        const voiceClip = $("voiceAudioClip");

        if (voiceClip) {
            voiceClip.style.width = "100%";
        }

        const keyboardClip = $("keyboardAudioClip");

        if (keyboardClip) {
            keyboardClip.style.width = "100%";
        }

        const rulerFragment = document.createDocumentFragment();

        for (
            let time = 0;
            time <= Math.max(60, state.duration);
            time += 5
        ) {
            const mark = document.createElement("span");

            mark.textContent = formatTime(time);

            mark.style.position = "absolute";
            mark.style.left =
                (time * 12 * state.zoom) + "px";

            mark.style.top = "7px";
            mark.style.fontSize = "10px";
            mark.style.color = "#8995ae";

            rulerFragment.appendChild(mark);
        }

        ruler?.replaceChildren(rulerFragment);

        updatePlayhead();
    }

    function updatePlayhead() {
        const playhead = $("playhead");

        if (!playhead) {
            return;
        }

        const x =
            state.playPosition *
            12 *
            state.zoom;

        playhead.style.left = x + "px";
    }

    /* ========================================================
       20. WAVEFORM DRAWING
       ======================================================== */

    function drawWaveform(buffer) {
        const canvas = $("waveformCanvas");

        if (!canvas || !buffer) {
            return;
        }

        const rect = canvas.getBoundingClientRect();

        const width = Math.max(
            300,
            Math.floor(rect.width || 800)
        );

        const height = Math.max(
            35,
            Math.floor(rect.height || 50)
        );

        const dpr = window.devicePixelRatio || 1;

        canvas.width = width * dpr;
        canvas.height = height * dpr;

        const ctx = canvas.getContext("2d");

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.clearRect(0, 0, width, height);

        const data = buffer.getChannelData(0);

        const samplesPerPixel = Math.max(
            1,
            Math.floor(data.length / width)
        );

        const middle = height / 2;

        const gradient = ctx.createLinearGradient(
            0,
            0,
            width,
            height
        );

        gradient.addColorStop(0, "#38e8ff");
        gradient.addColorStop(0.55, "#a66cff");
        gradient.addColorStop(1, "#ff55cf");

        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1;

        ctx.beginPath();

        for (let x = 0; x < width; x++) {
            const start = x * samplesPerPixel;

            let min = 1;
            let max = -1;

            for (
                let i = start;
                i < Math.min(
                    start + samplesPerPixel,
                    data.length
                );
                i++
            ) {
                min = Math.min(min, data[i]);
                max = Math.max(max, data[i]);
            }

            const top = middle - max * middle * 0.92;
            const bottom = middle - min * middle * 0.92;

            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
        }

        ctx.stroke();

        const empty = $("emptyWaveform");

        if (empty) {
            empty.style.display = "none";
        }
    }

    /* ========================================================
       21. VISUALIZER
       ======================================================== */

    function updateVisualizer() {
        const canvas = $("visualizer");

        if (!canvas) {
            return;
        }

        const rect = canvas.getBoundingClientRect();

        const width = Math.max(200, rect.width);
        const height = Math.max(35, rect.height);

        const dpr = window.devicePixelRatio || 1;

        if (
            canvas.width !== Math.floor(width * dpr) ||
            canvas.height !== Math.floor(height * dpr)
        ) {
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
        }

        const ctx = canvas.getContext("2d");

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const analyser = state.masterAnalyser;

        if (!analyser) {
            return;
        }

        const data = new Uint8Array(analyser.frequencyBinCount);

        analyser.getByteFrequencyData(data);

        const barWidth = 3;
        const gap = 2;

        const count = Math.floor(
            width / (barWidth + gap)
        );

        const gradient = ctx.createLinearGradient(
            0,
            height,
            0,
            0
        );

        gradient.addColorStop(0, "#38e8ff");
        gradient.addColorStop(0.55, "#a66cff");
        gradient.addColorStop(1, "#ff55cf");

        ctx.fillStyle = gradient;

        for (let i = 0; i < count; i++) {
            const index = Math.floor(
                i / count * data.length * 0.65
            );

            const amplitude = data[index] / 255;

            const barHeight = Math.max(
                2,
                amplitude * height * 0.9
            );

            const x = i * (barWidth + gap);

            ctx.fillRect(
                x,
                (height - barHeight) / 2,
                barWidth,
                barHeight
            );
        }

        if (state.playing) {
            requestAnimationFrame(updateVisualizer);
        }
    }

    /* ========================================================
       22. LIVE CONTROL BINDINGS
       ======================================================== */

    function bindRange(id, setting, min, max, valueId) {
        const input = $(id);

        if (!input) {
            return;
        }

        input.addEventListener("input", () => {
            const value = clamp(
                Number(input.value),
                min,
                max
            );

            state.settings[setting] = value;

            safeText(
                valueId,
                value +
                (
                    setting === "pan" ||
                    setting.endsWith("Pan")
                        ? ""
                        : "%"
                )
            );

            applyAllTrackSettings();
            updateProjectState();
        });
    }

    function bindControls() {
        bindRange(
            "volumeControl",
            "volume",
            0,
            200,
            "volumeValue"
        );

        bindRange(
            "bassControl",
            "bass",
            -24,
            24,
            "bassValue"
        );

        bindRange(
            "midControl",
            "mid",
            -24,
            24,
            "midValue"
        );

        bindRange(
            "trebleControl",
            "treble",
            -24,
            24,
            "trebleValue"
        );

        bindRange(
            "panControl",
            "pan",
            -100,
            100,
            "panValue"
        );

        bindRange(
            "reverbControl",
            "reverb",
            0,
            100,
            "reverbValue"
        );

        bindRange(
            "delayControl",
            "delay",
            0,
            100,
            "delayValue"
        );

        bindRange(
            "distortionControl",
            "distortion",
            0,
            100,
            "distortionValue"
        );

        bindRange(
            "fadeInControl",
            "fadeIn",
            0,
            30,
            "fadeInValue"
        );

        bindRange(
            "fadeOutControl",
            "fadeOut",
            0,
            30,
            "fadeOutValue"
        );

        bindRange(
            "mixerVolume",
            "masterVolume",
            0,
            150,
            "masterLevelText"
        );

        bindRange(
            "mixerTrackVolume",
            "musicVolume",
            0,
            200,
            null
        );

        bindRange(
            "voiceVolume",
            "voiceVolume",
            0,
            200,
            null
        );

        bindRange(
            "instrumentMixerVolume",
            "keyboardVolume",
            0,
            200,
            null
        );

        bindRange(
            "mixerPan",
            "musicPan",
            -100,
            100,
            null
        );

        bindRange(
            "voicePan",
            "voicePan",
            -100,
            100,
            null
        );

        bindRange(
            "instrumentMixerPan",
            "keyboardPan",
            -100,
            100,
            null
        );

        bindRange(
            "monitoringControl",
            "monitoring",
            0,
            100,
            "monitoringValue"
        );

        const speed = $("playbackSpeed");

        if (speed) {
            speed.addEventListener("change", () => {
                state.settings.speed = clamp(
                    Number(speed.value) || 1,
                    0.25,
                    2
                );

                [
                    state.music,
                    state.voice,
                    state.keyboard
                ].forEach((track) => {
                    if (track.element) {
                        track.element.playbackRate =
                            state.settings.speed;
                    }
                });
            });
        }

        [
            ["musicVolume", "music"],
            ["voiceVolume", "voice"],
            ["instrumentMixerVolume", "keyboard"]
        ].forEach(([id, type]) => {
            const input = $(id);

            if (!input) {
                return;
            }

            input.addEventListener("input", () => {
                state[type].volume = Number(input.value);

                applyTrackSettings(state[type]);
            });
        });

        [
            ["mixerPan", "music"],
            ["voicePan", "voice"],
            ["instrumentMixerPan", "keyboard"]
        ].forEach(([id, type]) => {
            const input = $(id);

            if (!input) {
                return;
            }

            input.addEventListener("input", () => {
                state[type].pan = Number(input.value);

                applyTrackSettings(state[type]);
            });
        });
    }

    /* ========================================================
       23. RESET EFFECTS
       ======================================================== */

    function resetAdjustments() {
        const defaults = {
            volume: 100,
            bass: 0,
            mid: 0,
            treble: 0,
            pan: 0,
            reverb: 0,
            delay: 0,
            distortion: 0,
            fadeIn: 0,
            fadeOut: 0,
            bypass: false
        };

        Object.assign(state.settings, defaults);

        const controls = {
            volumeControl: 100,
            bassControl: 0,
            midControl: 0,
            trebleControl: 0,
            panControl: 0,
            reverbControl: 0,
            delayControl: 0,
            distortionControl: 0,
            fadeInControl: 0,
            fadeOutControl: 0
        };

        Object.entries(controls).forEach(([id, value]) => {
            const input = $(id);

            if (input) {
                input.value = String(value);
                input.dispatchEvent(
                    new Event("input", { bubbles: true })
                );
            }
        });

        applyAllTrackSettings();

        toast("Audio adjustments reset godhame.", "success");
    }

    /* ========================================================
       24. COMPARE A/B
       ======================================================== */

    function toggleCompare() {
        state.settings.bypass = !state.settings.bypass;

        applyAllTrackSettings();

        const button = $("compareBtn");

        if (button) {
            button.classList.toggle(
                "active",
                state.settings.bypass
            );

            button.textContent =
                state.settings.bypass
                    ? "A/B: Original"
                    : "A/B: Edited";
        }

        safeText(
            "compareStatus",
            state.settings.bypass
                ? "Original processing bypassed"
                : "Edited sound active"
        );
    }

    /* ========================================================
       25. PRESETS
       ======================================================== */

    const PRESETS = {
        clean: {
            bass: 0,
            mid: 0,
            treble: 1,
            reverb: 0,
            delay: 0,
            distortion: 0
        },

        warm: {
            bass: 4,
            mid: 1,
            treble: -2,
            reverb: 10,
            delay: 0,
            distortion: 0
        },

        bright: {
            bass: -1,
            mid: 1,
            treble: 5,
            reverb: 7,
            delay: 0,
            distortion: 0
        },

        rap: {
            bass: 4,
            mid: 2,
            treble: 3,
            reverb: 8,
            delay: 5,
            distortion: 3
        },

        gospel: {
            bass: 2,
            mid: 1,
            treble: 3,
            reverb: 32,
            delay: 14,
            distortion: 0
        },

        studio: {
            bass: 1,
            mid: 0,
            treble: 2,
            reverb: 4,
            delay: 0,
            distortion: 0
        }
    };

    function applyPreset(name) {
        const preset = PRESETS[name];

        if (!preset) {
            return;
        }

        Object.assign(state.settings, preset);

        const controls = {
            bassControl: preset.bass,
            midControl: preset.mid,
            trebleControl: preset.treble,
            reverbControl: preset.reverb,
            delayControl: preset.delay,
            distortionControl: preset.distortion
        };

        Object.entries(controls).forEach(([id, value]) => {
            const input = $(id);

            if (input) {
                input.value = String(value);

                input.dispatchEvent(
                    new Event("input", { bubbles: true })
                );
            }
        });

        applyAllTrackSettings();

        safeText(
            "presetStatus",
            "Preset applied: " + name
        );

        toast(
            name.toUpperCase() + " preset hojiirra ooleera.",
            "success"
        );
    }

    /* ========================================================
       26. VOICE RECORDING
       ======================================================== */

    async function startVoiceRecording() {
        const rec = state.recording;

        if (
            rec.recorder &&
            rec.recorder.state === "recording"
        ) {
            return;
        }

        try {
            if (
                !navigator.mediaDevices ||
                !navigator.mediaDevices.getUserMedia
            ) {
                throw new Error(
                    "Microphone API hin argamne. HTTPS website fayyadami."
                );
            }

            const stream =
                await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });

            rec.stream = stream;
            rec.chunks = [];
            rec.paused = false;
            rec.elapsedBeforePause = 0;
            rec.startedAt = performance.now();

            const mimeType = chooseRecorderMimeType();

            const options = mimeType
                ? { mimeType }
                : undefined;

            rec.recorder = options
                ? new MediaRecorder(stream, options)
                : new MediaRecorder(stream);

            rec.recorder.addEventListener("dataavailable", (event) => {
                if (event.data && event.data.size > 0) {
                    rec.chunks.push(event.data);
                }
            });

            rec.recorder.addEventListener("stop", () => {
                finishVoiceRecording();
            });

            rec.recorder.start(250);

            await setupMicrophoneMonitor(stream);

            startRecordingTimer();
            startMicrophoneVisualiser(stream);

            safeText("recordingState", "Recording...");
            safeText("recordingResultStatus", "Recording in progress");

            $("recordingOrb")?.classList.add("recording");

            toast(
                "Voice recording jalqabame.",
                "success"
            );
        } catch (error) {
            console.error(error);

            toast(
                "Microphone banuu hin dandeenye: " +
                (error.message || "permission ilaali."),
                "error"
            );
        }
    }

    function chooseRecorderMimeType() {
        if (!window.MediaRecorder) {
            return "";
        }

        const types = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/ogg;codecs=opus",
            "audio/mp4"
        ];

        return types.find((type) =>
            MediaRecorder.isTypeSupported(type)
        ) || "";
    }

    async function setupMicrophoneMonitor(stream) {
        try {
            const ctx = await ensureAudioContext();

            const rec = state.recording;

            rec.source = ctx.createMediaStreamSource(stream);

            rec.monitorGain = ctx.createGain();

            rec.monitorGain.gain.value =
                state.settings.monitoring / 100;

            rec.analyser = ctx.createAnalyser();
            rec.analyser.fftSize = 2048;

            rec.source.connect(rec.analyser);

            rec.source.connect(rec.monitorGain);

            rec.monitorGain.connect(state.masterGain);

            if (state.settings.monitoring <= 0) {
                rec.monitorGain.gain.value = 0;
            }

            if (state.settings.monitoring > 0) {
                toast(
                    "Monitoring on dha. Echo hir'isuuf headphone fayyadami."
                );
            }
        } catch (error) {
            console.warn(
                "Microphone monitoring setup failed:",
                error
            );
        }
    }

    function pauseVoiceRecording() {
        const recorder = state.recording.recorder;

        if (!recorder || recorder.state !== "recording") {
            toast("Recording active miti.");
            return;
        }

        if (typeof recorder.pause !== "function") {
            toast(
                "Browser kee recording pause hin deeggaru.",
                "error"
            );
            return;
        }

        recorder.pause();

        state.recording.paused = true;

        state.recording.elapsedBeforePause +=
            performance.now() - state.recording.startedAt;

        clearInterval(state.recording.timer);

        safeText("recordingState", "Paused");

        $("recordingOrb")?.classList.add("paused");

        toast("Voice recording pause ta'e.");
    }

    function resumeVoiceRecording() {
        const recorder = state.recording.recorder;

        if (!recorder || recorder.state !== "paused") {
            toast("Recording pause irra hin jiru.");
            return;
        }

        recorder.resume();

        state.recording.paused = false;
        state.recording.startedAt = performance.now();

        $("recordingOrb")?.classList.remove("paused");

        safeText("recordingState", "Recording...");

        startRecordingTimer();

        toast("Voice recording itti fufe.");
    }

    function stopVoiceRecording() {
        const rec = state.recording;

        if (
            !rec.recorder ||
            rec.recorder.state === "inactive"
        ) {
            toast("Recording dhaabbateera.");
            return;
        }

        clearInterval(rec.timer);

        try {
            rec.recorder.stop();
        } catch (error) {
            console.warn(error);
        }

        if (rec.stream) {
            rec.stream.getTracks().forEach((track) => {
                track.stop();
            });
        }

        cancelAnimationFrame(rec.animation);

        if (rec.source) {
            try {
                rec.source.disconnect();
            } catch (_) {}
        }

        if (rec.monitorGain) {
            try {
                rec.monitorGain.disconnect();
            } catch (_) {}
        }

        safeText("recordingState", "Finishing...");
    }

    function finishVoiceRecording() {
        const rec = state.recording;

        clearInterval(rec.timer);

        if (rec.chunks.length === 0) {
            safeText(
                "recordingResultStatus",
                "Recording data hin argamne."
            );

            return;
        }

        const mimeType =
            rec.recorder?.mimeType ||
            "audio/webm";

        const blob = new Blob(
            rec.chunks,
            { type: mimeType }
        );

        rec.blob = blob;

        if (rec.url) {
            URL.revokeObjectURL(rec.url);
        }

        rec.url = URL.createObjectURL(blob);

        const preview = $("recordingPreview");

        if (preview) {
            preview.src = rec.url;
        }

        safeText(
            "recordingResultStatus",
            "Recording ready — " +
            Math.max(1, Math.round(blob.size / 1024)) +
            " KB"
        );

        safeText("recordingState", "Recording complete");

        $("recordingOrb")?.classList.remove(
            "recording",
            "paused"
        );

        toast(
            "Voice recording xumurame.",
            "success"
        );
    }

    function startRecordingTimer() {
        const rec = state.recording;

        clearInterval(rec.timer);

        rec.timer = setInterval(() => {
            if (
                !rec.recorder ||
                rec.recorder.state !== "recording"
            ) {
                return;
            }

            const elapsed =
                rec.elapsedBeforePause +
                performance.now() -
                rec.startedAt;

            safeText(
                "recordingTimer",
                formatTime(elapsed / 1000)
            );
        }, 250);
    }

    function startMicrophoneVisualiser(stream) {
        const canvas = $("recordingWaveform");

        if (!canvas) {
            return;
        }

        const rec = state.recording;

        if (!rec.analyser) {
            return;
        }

        const ctx2d = canvas.getContext("2d");

        const draw = () => {
            const rect = canvas.getBoundingClientRect();

            const width = Math.max(200, rect.width);
            const height = Math.max(60, rect.height);

            const dpr = window.devicePixelRatio || 1;

            if (
                canvas.width !== Math.floor(width * dpr) ||
                canvas.height !== Math.floor(height * dpr)
            ) {
                canvas.width = Math.floor(width * dpr);
                canvas.height = Math.floor(height * dpr);
            }

            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx2d.clearRect(0, 0, width, height);

            const analyser = rec.analyser;

            if (!analyser) {
                return;
            }

            const data = new Uint8Array(
                analyser.fftSize
            );

            analyser.getByteTimeDomainData(data);

            ctx2d.beginPath();

            ctx2d.strokeStyle = "#a66cff";
            ctx2d.lineWidth = 2;

            const step = width / data.length;

            for (let i = 0; i < data.length; i++) {
                const x = i * step;

                const y =
                    (data[i] / 255) * height;

                if (i === 0) {
                    ctx2d.moveTo(x, y);
                } else {
                    ctx2d.lineTo(x, y);
                }
            }

            ctx2d.stroke();

            if (
                rec.recorder &&
                rec.recorder.state === "recording"
            ) {
                rec.animation =
                    requestAnimationFrame(draw);
            }
        };

        draw();
    }

    /* ========================================================
       27. USE VOICE RECORDING
       ======================================================== */

    async function useVoiceRecording() {
        const blob = state.recording.blob;

        if (!blob) {
            toast(
                "Jalqaba voice recording xumuri.",
                "error"
            );
            return;
        }

        await loadSecondaryTrack(
            "voice",
            blob,
            "Voice Recording"
        );
    }

    function downloadBlob(blob, filename) {
        if (!blob) {
            toast("Faayila download gochuuf hin jiru.", "error");
            return;
        }

        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");

        a.href = url;
        a.download = filename;

        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 3000);
    }

    /* ========================================================
       28. VIRTUAL KEYBOARD
       ======================================================== */

    const NOTE_NAMES = [
        "C",
        "C#",
        "D",
        "D#",
        "E",
        "F",
        "F#",
        "G",
        "G#",
        "A",
        "A#",
        "B"
    ];

    const COMPUTER_KEYS = [
        "a",
        "w",
        "s",
        "e",
        "d",
        "f",
        "t",
        "g",
        "y",
        "h",
        "u",
        "j",
        "k",
        "o",
        "l",
        "p",
        ";"
    ];

    const activeOscillators = new Map();

    function midiToFrequency(midi) {
        return 440 * Math.pow(
            2,
            (midi - 69) / 12
        );
    }

    function midiToName(midi) {
        const note = NOTE_NAMES[midi % 12];

        const octave = Math.floor(midi / 12) - 1;

        return note + octave;
    }

    function getKeyboardInstrument() {
        return $("instrumentSelect")?.value || "piano";
    }

    function getKeyboardOctave() {
        return Number($("octaveSelect")?.value || 4);
    }

    function generatePianoKeyboard() {
        const container = $("pianoKeyboard");

        if (!container) {
            return;
        }

        container.replaceChildren();

        const octave = getKeyboardOctave();

        const startMidi = (octave + 1) * 12;

        const notes = [];

        for (let i = 0; i < 24; i++) {
            notes.push(startMidi + i);
        }

        notes.forEach((midi) => {
            const noteName = midiToName(midi);

            const isBlack = noteName.includes("#");

            const key = document.createElement("button");

            key.type = "button";

            key.className =
                "piano-key" +
                (isBlack ? " black" : "");

            key.dataset.midi = String(midi);

            key.setAttribute(
                "aria-label",
                "Play " + noteName
            );

            const label = document.createElement("span");

            label.textContent =
                COMPUTER_KEYS[
                    notes.indexOf(midi)
                ] || "";

            key.appendChild(label);

            key.addEventListener("pointerdown", (event) => {
                event.preventDefault();

                key.setPointerCapture?.(event.pointerId);

                key.classList.add("active");

                noteOn(midi, "pointer-" + event.pointerId);
            });

            const release = (event) => {
                key.classList.remove("active");

                noteOff(
                    midi,
                    "pointer-" + event.pointerId
                );
            };

            key.addEventListener("pointerup", release);
            key.addEventListener("pointercancel", release);

            key.addEventListener("lostpointercapture", release);

            container.appendChild(key);
        });
    }

    async function noteOn(midi, sourceId) {
        const ctx = await ensureAudioContext();

        const key = midi + ":" + sourceId;

        if (activeOscillators.has(key)) {
            return;
        }

        const instrument = getKeyboardInstrument();

        const gain = ctx.createGain();

        const volume =
            numberValue("keyboardVolume", 75) / 100;

        gain.gain.value = 0.0001;

        let oscillator;

        if (instrument === "electric") {
            oscillator = ctx.createOscillator();
            oscillator.type = "triangle";
        } else if (instrument === "bass") {
            oscillator = ctx.createOscillator();
            oscillator.type = "sawtooth";
        } else if (instrument === "synth") {
            oscillator = ctx.createOscillator();
            oscillator.type = "square";
        } else {
            oscillator = ctx.createOscillator();
            oscillator.type = "triangle";
        }

        oscillator.frequency.value =
            midiToFrequency(midi);

        const output = ctx.createGain();

        output.gain.value = volume;

        oscillator.connect(gain);
        gain.connect(output);
        output.connect(state.masterGain);

        const now = ctx.currentTime;

        const attack =
            instrument === "piano"
                ? 0.008
                : 0.025;

        gain.gain.setTargetAtTime(
            0.75,
            now,
            attack
        );

        oscillator.start(now);

        activeOscillators.set(key, {
            midi,
            sourceId,
            oscillator,
            gain,
            output,
            startedAt: performance.now()
        });

        recordKeyboardEvent({
            type: "on",
            midi,
            time: keyboardRecordingTime()
        });

        if (
            state.keyboardRecording.recording &&
            !state.keyboardRecording.paused
        ) {
            state.keyboardRecording.activeNotes.set(
                key,
                {
                    midi,
                    time: keyboardRecordingTime()
                }
            );
        }

        updateKeyboardStatus(
            "Playing " + midiToName(midi)
        );
    }

    function noteOff(midi, sourceId) {
        const key = midi + ":" + sourceId;

        const active = activeOscillators.get(key);

        if (!active) {
            return;
        }

        const ctx = state.audioContext;

        const now = ctx.currentTime;

        const sustain =
            $("sustainBtn")?.classList.contains("active");

        if (sustain) {
            return;
        }

        active.gain.gain.cancelScheduledValues(now);

        active.gain.gain.setTargetAtTime(
            0.0001,
            now,
            0.08
        );

        setTimeout(() => {
            try {
                active.oscillator.stop();
            } catch (_) {}

            try {
                active.oscillator.disconnect();
                active.gain.disconnect();
                active.output.disconnect();
            } catch (_) {}

            activeOscillators.delete(key);
        }, 450);

        recordKeyboardEvent({
            type: "off",
            midi,
            time: keyboardRecordingTime()
        });

        state.keyboardRecording.activeNotes.delete(key);
    }

    function releaseAllKeyboardNotes() {
        for (const item of activeOscillators.values()) {
            try {
                item.gain.gain.setTargetAtTime(
                    0.0001,
                    state.audioContext.currentTime,
                    0.03
                );

                item.oscillator.stop(
                    state.audioContext.currentTime + 0.2
                );
            } catch (_) {}
        }

        activeOscillators.clear();
    }

    function updateKeyboardStatus(text) {
        safeText("keyboardStatus", text);
    }

    /* ========================================================
       29. KEYBOARD RECORDING
       ======================================================== */

    function keyboardRecordingTime() {
        const rec = state.keyboardRecording;

        if (!rec.recording || rec.paused) {
            return rec.pausedAt;
        }

        return (
            performance.now() - rec.startedAt
        ) / 1000;
    }

    function recordKeyboardEvent(event) {
        const rec = state.keyboardRecording;

        if (!rec.recording || rec.paused) {
            return;
        }

        rec.events.push({
            ...event,
            time: Math.max(0, event.time)
        });
    }

    function startKeyboardRecording() {
        const rec = state.keyboardRecording;

        rec.events = [];
        rec.activeNotes.clear();

        rec.recording = true;
        rec.paused = false;

        rec.startedAt = performance.now();
        rec.pausedAt = 0;

        updateKeyboardStatus(
            "Recording keyboard performance..."
        );

        toast(
            "Keyboard recording jalqabame.",
            "success"
        );
    }

    function pauseKeyboardRecording() {
        const rec = state.keyboardRecording;

        if (!rec.recording || rec.paused) {
            return;
        }

        rec.pausedAt = keyboardRecordingTime();

        rec.paused = true;

        updateKeyboardStatus("Keyboard recording paused");

        toast("Keyboard recording pause ta'e.");
    }

    function resumeKeyboardRecording() {
        const rec = state.keyboardRecording;

        if (!rec.recording || !rec.paused) {
            return;
        }

        rec.startedAt =
            performance.now() -
            rec.pausedAt * 1000;

        rec.paused = false;

        updateKeyboardStatus(
            "Keyboard recording resumed"
        );

        toast("Keyboard recording itti fufe.");
    }

    async function stopKeyboardRecording() {
        const rec = state.keyboardRecording;

        if (!rec.recording) {
            toast("Keyboard recording active miti.");
            return;
        }

        if (!rec.paused) {
            rec.pausedAt = keyboardRecordingTime();
        }

        rec.recording = false;
        rec.paused = false;

        releaseAllKeyboardNotes();

        if (rec.events.length === 0) {
            updateKeyboardStatus(
                "Recording keessatti note hin taphatamne."
            );

            return;
        }

        try {
            rec.audioBuffer = await renderKeyboardBuffer(
                rec.events,
                Math.max(1, rec.pausedAt)
            );

            rec.blob = audioBufferToWav(rec.audioBuffer);

            if (rec.url) {
                URL.revokeObjectURL(rec.url);
            }

            rec.url = URL.createObjectURL(rec.blob);

            updateKeyboardStatus(
                "Keyboard recording ready — " +
                rec.events.length +
                " note events"
            );

            toast(
                "Keyboard recording xumurame.",
                "success"
            );
        } catch (error) {
            console.error(error);

            updateKeyboardStatus(
                "Keyboard audio render hin milkoofne."
            );
        }
    }

    async function renderKeyboardBuffer(events, duration) {
        const sampleRate = 44100;

        const length = Math.ceil(
            Math.min(duration + 1, 600) *
            sampleRate
        );

        const buffer = new AudioBuffer({
            length,
            numberOfChannels: 2,
            sampleRate
        });

        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);

        const active = new Map();

        const sorted = [...events].sort(
            (a, b) => a.time - b.time
        );

        const maxFrames = length;

        for (const event of sorted) {
            const frame = Math.floor(
                event.time * sampleRate
            );

            if (
                event.type === "on" &&
                frame < maxFrames
            ) {
                active.set(
                    event.midi,
                    frame
                );
            }

            if (
                event.type === "off" &&
                active.has(event.midi)
            ) {
                const start = active.get(event.midi);

                synthesizeOfflineNote(
                    left,
                    right,
                    event.midi,
                    start,
                    frame,
                    sampleRate
                );

                active.delete(event.midi);
            }
        }

        for (const [midi, start] of active.entries()) {
            synthesizeOfflineNote(
                left,
                right,
                midi,
                start,
                maxFrames - 1,
                sampleRate
            );
        }

        return buffer;
    }

    function synthesizeOfflineNote(
        left,
        right,
        midi,
        start,
        end,
        sampleRate
    ) {
        start = clamp(start, 0, left.length);
        end = clamp(end, start, left.length);

        const frequency = midiToFrequency(midi);

        const attackFrames = Math.max(
            1,
            Math.floor(sampleRate * 0.015)
        );

        const releaseFrames =
