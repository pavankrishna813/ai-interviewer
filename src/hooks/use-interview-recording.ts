"use client";

import { createLogger } from "@/lib/logger";
import {
    getStoredCameraStream,
    getStoredScreenStream,
    setStoredCameraStream,
    setStoredScreenStream,
    wasCameraSkipped,
    wasScreenSkipped,
} from "@/lib/media-stream-store";
import fixWebmDuration from "fix-webm-duration";
import { useCallback, useEffect, useRef, useState } from "react";

const log = createLogger("recording");

export interface ScreenshotEntry {
  url: string;
  path: string;
  timestamp: string;
  type: "camera" | "screen";
}

interface UseInterviewRecordingOptions {
  sessionId: string;
  enabled: boolean;
  screenshotIntervalMs?: number;
}

/**
 * Resolve the actual playable duration of a WebM audio or video blob.
 * WebM files from MediaRecorder often have Infinity/missing duration;
 * the seek-to-end trick forces the browser to compute it.
 */
function resolveBlobDuration(blob: Blob, isVideo = false): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const media: HTMLMediaElement = isVideo
      ? document.createElement("video")
      : new Audio();
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(undefined);
      }
    }, 5000);

    function cleanup() {
      clearTimeout(timeout);
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
    }

    function finish(dur: number) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(Math.round(dur));
    }

    media.addEventListener("durationchange", () => {
      if (media.duration && isFinite(media.duration) && media.duration > 0) {
        finish(media.duration);
      }
    });

    media.addEventListener("loadedmetadata", () => {
      if (media.duration && isFinite(media.duration) && media.duration > 0) {
        finish(media.duration);
      } else {
        media.currentTime = 1e10;
      }
    });

    media.addEventListener("timeupdate", () => {
      if (media.duration && isFinite(media.duration) && media.duration > 0) {
        finish(media.duration);
      }
    });

    media.preload = "auto";
    media.src = url;
  });
}

/**
 * Manages audio recording (combined mic + TTS), camera/screen streams,
 * and periodic screenshot capture during a voice interview.
 *
 * Audio mixing strategy:
 *   - A single AudioContext drives a MediaStreamAudioDestinationNode.
 *   - The mic MediaStream is piped in via createMediaStreamSource.
 *   - TTS PCM chunks (float32 @ 24 kHz) are decoded into AudioBuffers
 *     and played into the same destination via BufferSourceNodes.
 *   - MediaRecorder records the destination's combined stream as webm/opus.
 */
export function useInterviewRecording({
  sessionId,
  enabled,
  screenshotIntervalMs = 60_000,
}: UseInterviewRecordingOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  // Refs for recording infrastructure
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const videoRecorderRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<Blob[]>([]);
  const audioMimeRef = useRef<string>("");
  const mixCtxRef = useRef<AudioContext | null>(null);
  const mixDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const screenshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenshotsRef = useRef<ScreenshotEntry[]>([]);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const stoppedRef = useRef(false);
  const ttsPlayTimeRef = useRef(0);
  const ttsSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const videoStartTimeRef = useRef<number>(0);
  const audioClockCarrierRef = useRef<{ osc: OscillatorNode; gain: GainNode } | null>(null);

  // Keep refs in sync with state
  useEffect(() => { cameraStreamRef.current = cameraStream; }, [cameraStream]);
  useEffect(() => { screenStreamRef.current = screenStream; }, [screenStream]);

  /** Acquire camera and screen streams, reusing stored streams from onboarding. */
  const acquireStreams = useCallback(async () => {
    // Reuse camera stream from onboarding if still active
    const storedCam = getStoredCameraStream();
    if (storedCam) {
      setCameraStream(storedCam);
      cameraStreamRef.current = storedCam;
      setStoredCameraStream(null);
    } else if (!wasCameraSkipped()) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 640, height: 480 },
        });
        setCameraStream(cam);
        cameraStreamRef.current = cam;
      } catch (err) {
        log.warn("Camera not available:", err);
      }
    }

    // Reuse screen stream from onboarding if still active
    const storedScreen = getStoredScreenStream();
    if (storedScreen) {
      setScreenStream(storedScreen);
      screenStreamRef.current = storedScreen;
      setStoredScreenStream(null);

      storedScreen.getVideoTracks()[0]?.addEventListener("ended", () => {
        setScreenStream(null);
        screenStreamRef.current = null;
      });
    } else if (!wasScreenSkipped()) {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        setScreenStream(screen);
        screenStreamRef.current = screen;

        screen.getVideoTracks()[0]?.addEventListener("ended", () => {
          setScreenStream(null);
          screenStreamRef.current = null;
        });
      } catch (err) {
        log.warn("Screen share not available:", err);
      }
    }
  }, []);

  /** Pipe a mic MediaStream into the recording mixer. */
  const attachMicStream = useCallback((micStream: MediaStream) => {
    const ctx = mixCtxRef.current;
    if (!ctx || !mixDestRef.current) return;

    // Disconnect previous mic source if any
    try { micSourceRef.current?.disconnect(); } catch { /* noop */ }

    try {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
      const source = ctx.createMediaStreamSource(micStream);
      source.connect(mixDestRef.current);
      micSourceRef.current = source;
      log.info("Mic stream connected to recording mixer");
    } catch (err) {
      log.error("Failed to connect mic stream to recording mixer:", err);
    }
  }, []);

  /**
   * Feed a TTS PCM chunk (float32 @ 24 kHz) into the recording mixer.
   * Chunks are scheduled sequentially to avoid overlapping audio.
   */
  const addTtsChunk = useCallback((pcmData: ArrayBuffer) => {
    const ctx = mixCtxRef.current;
    const dest = mixDestRef.current;
    if (!ctx || !dest || pcmData.byteLength === 0) return;

    const float32 = new Float32Array(pcmData);
    const sampleRate = 24000;
    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(dest);

    const startAt = Math.max(ctx.currentTime, ttsPlayTimeRef.current);
    source.start(startAt);
    ttsPlayTimeRef.current = startAt + audioBuffer.duration;

    ttsSourcesRef.current.push(source);
    source.onended = () => {
      ttsSourcesRef.current = ttsSourcesRef.current.filter((s) => s !== source);
    };
  }, []);

  /**
   * Cancel all scheduled TTS sources in the recording mixer.
   * Must be called when the user interrupts the agent so the recording
   * only contains audio that was actually heard.
   */
  const cancelTts = useCallback(() => {
    for (const source of ttsSourcesRef.current) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    ttsSourcesRef.current = [];
    ttsPlayTimeRef.current = 0;
  }, []);

  /** Capture a screenshot from a video element and upload it. */
  const captureAndUpload = useCallback(
    async (video: HTMLVideoElement, type: "camera" | "screen") => {
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;

      if (type === "camera") {
        ctx2d.translate(canvas.width, 0);
        ctx2d.scale(-1, 1);
      }
      ctx2d.drawImage(video, 0, 0);

      // Ensure camera snapshots always capture a visible face
      if (type === "camera") {
        try {
          const { detectFace } = await import("@/lib/proctor/face-check");
          const faceCheck = await detectFace(canvas);
          if (!faceCheck.hasFace) {
            log.warn("Periodic camera snapshot skipped: No face detected in frame", faceCheck.reason);
            return;
          }
        } catch (err) {
          log.warn("Snapshot face check skipped on error:", err);
        }
      }

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7),
      );
      if (!blob) return;

      const timestamp = new Date().toISOString();
      const filename = `${timestamp.replace(/[:.]/g, "-")}-${type}.jpg`;

      try {
        const form = new FormData();
        form.append("file", blob, filename);
        form.append("sessionId", sessionId);
        form.append("type", "screenshot");
        form.append("filename", filename);

        const res = await fetch("/api/session/upload", {
          method: "POST",
          body: form,
        });

        if (res.ok) {
          const data = await res.json();
          screenshotsRef.current.push({
            url: data.url,
            path: data.path,
            timestamp,
            type,
          });
          log.info(`Screenshot uploaded: ${type}`);
        }
      } catch (err) {
        log.error("Screenshot upload failed:", err);
      }
    },
    [sessionId],
  );

  /** Take screenshots from both camera and screen streams. */
  const takeScreenshots = useCallback(() => {
    if (cameraVideoRef.current && cameraStreamRef.current) {
      captureAndUpload(cameraVideoRef.current, "camera");
    }
    if (screenVideoRef.current && screenStreamRef.current) {
      captureAndUpload(screenVideoRef.current, "screen");
    }
  }, [captureAndUpload]);

  /** Start recording audio and periodic screenshots. */
  const start = useCallback(
    async (micStream?: MediaStream) => {
      if (!enabled || isRecording) return;
      stoppedRef.current = false;
      ttsPlayTimeRef.current = 0;
      recordingStartTimeRef.current = Date.now();

      // 1. Acquire camera + screen FIRST so video hardware is active and buffered
      await acquireStreams();

      // 2. Set up hidden video elements for screenshot capture
      if (!cameraVideoRef.current) {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.style.display = "none";
        document.body.appendChild(v);
        cameraVideoRef.current = v;
      }
      if (!screenVideoRef.current) {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.style.display = "none";
        document.body.appendChild(v);
        screenVideoRef.current = v;
      }

      // Bind streams to hidden video elements for canvas capture
      const bindStream = (video: HTMLVideoElement, stream: MediaStream | null) => {
        if (stream) {
          video.srcObject = stream;
          video.play().catch(() => {});
        }
      };
      bindStream(cameraVideoRef.current!, cameraStreamRef.current);
      bindStream(screenVideoRef.current!, screenStreamRef.current);

      // 3. Create mixing AudioContext and destination in lockstep with video
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (e) {
          log.warn("AudioContext resume failed:", e);
        }
      }
      mixCtxRef.current = ctx;
      const dest = ctx.createMediaStreamDestination();
      mixDestRef.current = dest;

      // 4. Attach micStream immediately to the mixer
      if (micStream && micStream.getAudioTracks().length > 0) {
        attachMicStream(micStream);
      }

      // 5. Keep WebAudio clock generating continuous frames from timestamp 0.000s
      // by attaching an inaudible carrier:
      try {
        const osc = ctx.createOscillator();
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0.00001; // virtually silent, guarantees constant audio packet flow
        osc.connect(silentGain);
        silentGain.connect(dest);
        osc.start();
        audioClockCarrierRef.current = { osc, gain: silentGain };
      } catch (oscErr) {
        log.warn("Failed to start audio clock carrier:", oscErr);
      }

      // 6. Start MediaRecorder (audio) and VideoRecorder in lockstep at the same timestamp
      chunksRef.current = [];
      const preferredMime = ["audio/mp4", "audio/mp4;codecs=aac", "audio/webm;codecs=opus", "audio/webm"]
        .find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      audioMimeRef.current = preferredMime;
      try {
        const recorder = new MediaRecorder(dest.stream, {
          ...(preferredMime ? { mimeType: preferredMime } : {}),
        });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start(1000); // 1s timeslices
        recorderRef.current = recorder;
      } catch (aErr) {
        log.error("Failed to start audio recorder:", aErr);
      }

      // Start video recorder IMMEDIATELY synchronized with the audio mixer
      const videoTrack =
        cameraStreamRef.current?.getVideoTracks()[0] ||
        screenStreamRef.current?.getVideoTracks()[0];

      if (videoTrack && mixDestRef.current) {
        try {
          const combinedStream = new MediaStream([
            ...mixDestRef.current.stream.getAudioTracks(),
            videoTrack,
          ]);
          const preferredVideoMime = [
            "video/webm;codecs=vp8,opus",
            "video/webm;codecs=vp9,opus",
            "video/webm",
            "video/mp4",
          ].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

          videoChunksRef.current = [];
          const videoRec = new MediaRecorder(combinedStream, {
            ...(preferredVideoMime ? { mimeType: preferredVideoMime } : {}),
            videoBitsPerSecond: 1_000_000,
          });
          videoRec.ondataavailable = (e) => {
            if (e.data.size > 0) videoChunksRef.current.push(e.data);
          };
          videoRec.start(1000); // 1s timeslices for precise keyframes and lip sync
          videoRecorderRef.current = videoRec;
          videoStartTimeRef.current = Date.now();
          log.info("Synchronized full video recorder started with MIME:", preferredVideoMime);
        } catch (vErr) {
          log.error("Failed to start video recorder:", vErr);
        }
      }

      // Start periodic screenshot timer
      screenshotTimerRef.current = setInterval(takeScreenshots, screenshotIntervalMs);

      setIsRecording(true);
      log.info("Synchronized recording session started");
    },
    [enabled, isRecording, acquireStreams, attachMicStream, takeScreenshots, screenshotIntervalMs],
  );

  /**
   * Stop recording. Uploads the audio blob and returns recording metadata.
   * Returns the list of screenshot entries.
   */
  const stop = useCallback(async (): Promise<{
    audioUrl?: string;
    videoUrl?: string;
    audioDuration?: number;
    screenshots: ScreenshotEntry[];
  }> => {
    if (stoppedRef.current) {
      return { screenshots: screenshotsRef.current };
    }
    stoppedRef.current = true;

    // Stop screenshot timer
    if (screenshotTimerRef.current) {
      clearInterval(screenshotTimerRef.current);
      screenshotTimerRef.current = null;
    }

    // Take one final set of screenshots
    takeScreenshots();

    // Stop MediaRecorder (audio) and VideoRecorder in parallel
    let audioUrl: string | undefined;
    let videoUrl: string | undefined;
    let audioDuration: number | undefined;

    const stopAudioPromise = new Promise<Blob | null>((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") return resolve(null);
      recorder.onstop = () => {
        const mime = audioMimeRef.current || "audio/webm";
        const rawBlob = new Blob(chunksRef.current, { type: mime });
        resolve(rawBlob.size > 0 ? rawBlob : null);
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });

    const stopVideoPromise = new Promise<Blob | null>((resolve) => {
      const vRecorder = videoRecorderRef.current;
      if (!vRecorder || vRecorder.state === "inactive") return resolve(null);
      vRecorder.onstop = () => {
        const rawVideoBlob = new Blob(videoChunksRef.current, { type: "video/webm" });
        resolve(rawVideoBlob.size > 0 ? rawVideoBlob : null);
      };
      try {
        vRecorder.stop();
      } catch {
        resolve(null);
      }
    });

    const [rawAudioBlob, rawVideoBlob] = await Promise.all([
      stopAudioPromise,
      stopVideoPromise,
    ]);

    // Process and upload audio and video in parallel for speed
    const uploadAudioTask = (async () => {
      if (!rawAudioBlob) return;
      const mime = audioMimeRef.current || "audio/webm";
      const isWebm = mime.includes("webm");
      const ext = isWebm ? "webm" : "m4a";

      audioDuration = await resolveBlobDuration(rawAudioBlob);
      const audioBlob =
        isWebm && audioDuration
          ? await fixWebmDuration(rawAudioBlob, audioDuration * 1000)
          : rawAudioBlob;

      try {
        const fname = `recording-${Date.now()}.${ext}`;
        const form = new FormData();
        form.append("file", audioBlob, fname);
        form.append("sessionId", sessionId);
        form.append("type", "recording");
        form.append("filename", fname);

        const res = await fetch("/api/session/upload", {
          method: "POST",
          body: form,
        });
        if (res.ok) {
          const data = await res.json();
          audioUrl = data.url;
          log.info("Audio uploaded successfully:", audioUrl);
        } else {
          log.error("Audio upload failed HTTP status:", res.status);
        }
      } catch (err) {
        log.error("Audio upload network exception:", err);
      }
    })();

    const uploadVideoTask = (async () => {
      if (!rawVideoBlob) return;
      try {
        const isWebm = rawVideoBlob.type.includes("webm") || !rawVideoBlob.type;
        const ext = isWebm ? "webm" : "mp4";
        const fname = `video-${Date.now()}.${ext}`;

        let finalVideoBlob = rawVideoBlob;
        if (isWebm) {
          // Resolve duration via seek trick or fall back to recorded wall-clock time
          const resolvedDur = await resolveBlobDuration(rawVideoBlob, true);
          const wallClockDuration = videoStartTimeRef.current > 0
            ? (Date.now() - videoStartTimeRef.current) / 1000
            : (Date.now() - recordingStartTimeRef.current) / 1000;
          const targetDurationSec = (resolvedDur && isFinite(resolvedDur) && resolvedDur > 0)
            ? resolvedDur
            : wallClockDuration;

          if (targetDurationSec > 0) {
            try {
              finalVideoBlob = await fixWebmDuration(rawVideoBlob, Math.round(targetDurationSec * 1000));
              log.info("Fixed WebM video duration successfully:", targetDurationSec, "seconds");
            } catch (fixErr) {
              log.warn("fixWebmDuration failed for video, using raw blob:", fixErr);
            }
          }
        }

        const form = new FormData();
        form.append("file", finalVideoBlob, fname);
        form.append("sessionId", sessionId);
        form.append("type", "video");
        form.append("filename", fname);

        const res = await fetch("/api/session/upload", {
          method: "POST",
          body: form,
        });
        if (res.ok) {
          const data = await res.json();
          videoUrl = data.url;
          log.info("Video recording uploaded successfully:", videoUrl);
        } else {
          const errText = await res.text();
          log.error("Video upload failed HTTP status:", res.status, errText);
        }
      } catch (err) {
        log.error("Video upload network exception:", err);
      }
    })();

    await Promise.allSettled([uploadAudioTask, uploadVideoTask]);

    // Disconnect mic source
    try { micSourceRef.current?.disconnect(); } catch { /* noop */ }
    micSourceRef.current = null;

    // Stop and disconnect continuous carrier oscillator
    try {
      audioClockCarrierRef.current?.osc.stop();
      audioClockCarrierRef.current?.osc.disconnect();
      audioClockCarrierRef.current?.gain.disconnect();
    } catch { /* noop */ }
    audioClockCarrierRef.current = null;

    // Close mix context
    try { mixCtxRef.current?.close(); } catch { /* noop */ }
    mixCtxRef.current = null;
    mixDestRef.current = null;
    recorderRef.current = null;
    videoRecorderRef.current = null;

    // Stop camera/screen tracks
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    setCameraStream(null);
    setScreenStream(null);

    // Clean up hidden video elements
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
      cameraVideoRef.current.remove();
      cameraVideoRef.current = null;
    }
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
      screenVideoRef.current.remove();
      screenVideoRef.current = null;
    }

    setIsRecording(false);
    log.info("Stopped");

    return {
      audioUrl,
      videoUrl,
      audioDuration,
      screenshots: screenshotsRef.current,
    };
  }, [sessionId, takeScreenshots]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (screenshotTimerRef.current) clearInterval(screenshotTimerRef.current);
      try { recorderRef.current?.stop(); } catch { /* noop */ }
      try { micSourceRef.current?.disconnect(); } catch { /* noop */ }
      try { mixCtxRef.current?.close(); } catch { /* noop */ }
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (cameraVideoRef.current) { cameraVideoRef.current.remove(); cameraVideoRef.current = null; }
      if (screenVideoRef.current) { screenVideoRef.current.remove(); screenVideoRef.current = null; }
    };
  }, []);

  return {
    start,
    stop,
    addTtsChunk,
    cancelTts,
    attachMicStream,
    cameraStream,
    screenStream,
    isRecording,
    screenshots: screenshotsRef,
  };
}
