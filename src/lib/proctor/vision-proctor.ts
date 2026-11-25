/**
 * Vision Proctor Engine
 *
 * Runs client-side face, gaze, blink, and lip-sync tracking using MediaPipe.
 * Cross-references camera vision with microphone audio level to detect:
 *  - Face absence / departure
 *  - Face restored
 *  - Multiple persons in frame
 *  - Head pose & looking away from screen (reading from second screen/phone)
 *  - Eye blink absence (static photo / deepfake freeze)
 *  - Lip-sync mismatch (audio speaking but mouth stationary)
 *  - Hand wave / liveness challenge
 *  - Virtual audio driver detection
 */

import {
  compareFaceVectors,
  extractFaceBiometricVector,
} from "./face-check";
import {
  detectFaceWithHuman,
  compareFaceEmbeddings,
  getHuman,
} from "./human-check";

export type ProctorAlertType =
  | "face_missing"
  | "face_restored"
  | "face_mismatch"
  | "looking_away"
  | "lip_sync_mismatch"
  | "multiple_faces"
  | "no_blinking"
  | "hand_wave_verified"
  | "virtual_device_detected";

export interface ProctorAlertEvent {
  type: ProctorAlertType;
  timestamp: number;
  detail?: string;
}

export type ProctorAlertCallback = (alert: ProctorAlertEvent) => void;

export class VisionProctor {
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private running = false;
  private animFrameId: number | null = null;
  private onAlert: ProctorAlertCallback;

  // MediaPipe landmarker instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private faceLandmarker: any = null;
  private isModelLoading = false;
  private lastVideoTimestampMs = 0;

  // Proctor state trackers
  private isFaceMissing = false;
  private faceMissingStart = 0;
  private multipleFacesStart = 0;
  private lookingAwayStart = 0;
  private lookingAwayLastSeen = 0;
  private lastBlinkTimestamp = Date.now();

  // Lip-sync tracking buffers
  private recentLipOpenings: number[] = [];
  private recentAudioSpeechFrames: boolean[] = [];
  private recentMouthActiveFrames: boolean[] = [];

  // Alert cooldowns to avoid spamming
  private alertCooldowns: Record<string, number> = {};

  // Audio cross-reference (updated from audio pipeline)
  private currentAudioLevel = 0;

  // Liveness challenge state
  private expectingHandWave = false;

  // Face identity mismatch tracking
  private referenceFaceVector: number[] | null = null;
  private faceMismatchStart = 0;
  private lastHumanCheckTime = 0;
  private spoofAlertStart = 0;

  constructor(onAlert: ProctorAlertCallback) {
    this.onAlert = onAlert;
  }

  /** Set the candidate's baseline biometric vector from onboarding reference photo */
  public setReferenceFace(vector: number[] | null): void {
    this.referenceFaceVector = vector;
    this.faceMismatchStart = 0;
  }

  /** Initialize Vision Proctor asynchronously */
  public async init(): Promise<void> {
    // Warm up Human.js in parallel for neural face matching and 3D pose
    void getHuman();

    if (typeof window === "undefined" || this.faceLandmarker || this.isModelLoading) return;
    this.isModelLoading = true;

    try {
      // Dynamic import to avoid SSR issues
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");

      // Try local wasm first (fast, reliable offline/behind corporate firewalls), fallback to CDN
      let filesetResolver;
      try {
        filesetResolver = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      } catch {
        filesetResolver = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
      }

      const localModelPath = "/mediapipe/face_landmarker.task";
      const cdnModelPath =
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

      // Try GPU delegate first; if WebGL2 context or hardware acceleration fails, fallback to CPU
      try {
        this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: localModelPath,
            delegate: "GPU",
          },
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          runningMode: "VIDEO",
          numFaces: 2,
        });
      } catch (gpuErr) {
        console.warn("[VisionProctor] GPU delegate failed, attempting CPU fallback:", gpuErr);
        try {
          this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
              modelAssetPath: localModelPath,
              delegate: "CPU",
            },
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            runningMode: "VIDEO",
            numFaces: 2,
          });
        } catch (cpuErr) {
          console.warn("[VisionProctor] Local model failed, attempting CDN CPU fallback:", cpuErr);
          this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
              modelAssetPath: cdnModelPath,
              delegate: "CPU",
            },
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            runningMode: "VIDEO",
            numFaces: 2,
          });
        }
      }

      console.info("[VisionProctor] MediaPipe FaceLandmarker initialized successfully");
      // Run virtual device check once initialized
      this.checkVirtualAudioDevices();
    } catch (err) {
      console.warn("[VisionProctor] MediaPipe initialization error (using canvas fallback):", err);
    } finally {
      this.isModelLoading = false;
    }
  }

  /** Inspect audio input devices for synthetic/virtual audio cables */
  public async checkVirtualAudioDevices(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const virtualKeywords = [
        "vb-audio",
        "voicemeeter",
        "virtual cable",
        "blackhole",
        "soundflower",
        "cable input",
        "cable output",
      ];

      for (const d of devices) {
        if (d.kind === "audioinput") {
          const labelLower = d.label.toLowerCase();
          for (const kw of virtualKeywords) {
            if (labelLower.includes(kw)) {
              this.dispatchAlert("virtual_device_detected", `Virtual audio driver detected: ${d.label}`);
              return;
            }
          }
        }
      }
    } catch {
      // Browser permissions may hide device labels until stream granted
    }
  }

  /** Update current mic audio level (0.0 to 1.0) from voice pipeline */
  public updateAudioLevel(level: number): void {
    this.currentAudioLevel = level;
  }

  /** Request the candidate to perform a hand-wave liveness check */
  public requestHandWaveChallenge(): void {
    this.expectingHandWave = true;
    setTimeout(() => {
      this.expectingHandWave = false;
    }, 10_000); // 10-second challenge window
  }

  /** Start monitoring a video stream */
  public start(video: HTMLVideoElement): void {
    if (this.running) this.stop();
    this.videoElement = video;
    this.running = true;

    // Create hidden canvas for pixel sampling fallback
    this.canvasElement = document.createElement("canvas");
    this.canvasElement.width = 160;
    this.canvasElement.height = 120;
    this.canvasCtx = this.canvasElement.getContext("2d", { willReadFrequently: true });

    this.lastBlinkTimestamp = Date.now();
    this.loop();
  }

  /** Stop monitoring */
  public stop(): void {
    this.running = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.videoElement = null;
    this.canvasElement = null;
    this.canvasCtx = null;
    this.recentLipOpenings = [];
    this.recentAudioSpeechFrames = [];
    this.recentMouthActiveFrames = [];
  }

  /** Main analysis loop running at ~10 FPS to ensure minimal CPU usage */
  private lastProcessTime = 0;
  private loop = (): void => {
    if (!this.running) return;

    const now = performance.now();
    // Process every 100ms (~10 FPS is optimal for real-time proctoring with negligible CPU)
    if (now - this.lastProcessTime >= 100) {
      this.lastProcessTime = now;
      this.processCurrentFrame();
    }

    this.animFrameId = requestAnimationFrame(this.loop);
  };

  /** Analyze current video frame */
  private processCurrentFrame(): void {
    const video = this.videoElement;
    if (!video || video.readyState < 2 || video.paused) return;

    const now = Date.now();
    if (now - this.lastHumanCheckTime >= 1000) {
      this.lastHumanCheckTime = now;
      void this.processHumanProctor(video);
    }

    if (this.faceLandmarker) {
      this.processMediaPipe(video);
    } else {
      this.processCanvasFallback(video);
    }
  }

  /** Process using MediaPipe FaceLandmarker with blendshapes */
  private processMediaPipe(video: HTMLVideoElement): void {
    try {
      // MediaPipe requires strictly monotonic increasing timestamps
      let timestampMs = Math.round(performance.now());
      if (timestampMs <= this.lastVideoTimestampMs) {
        timestampMs = this.lastVideoTimestampMs + 1;
      }
      this.lastVideoTimestampMs = timestampMs;

      const results = this.faceLandmarker.detectForVideo(video, timestampMs);
      const faceCount = results.faceLandmarks?.length || 0;
      const now = Date.now();

      // ── 1. Face Absence & Multiple Faces ───────────────────
      if (faceCount === 0) {
        if (!this.faceMissingStart) this.faceMissingStart = now;
        if (now - this.faceMissingStart >= 3500 && !this.isFaceMissing) {
          this.isFaceMissing = true;
          this.dispatchAlert("face_missing", "Candidate face is not visible in camera frame");
        }
        return; // No face to analyze further
      }

      // Face restored
      if (this.isFaceMissing && faceCount >= 1) {
        this.isFaceMissing = false;
        this.faceMissingStart = 0;
        this.dispatchAlert("face_restored", "Candidate face has returned to frame");
      }
      this.faceMissingStart = 0;

      // Multiple faces detected
      if (faceCount > 1) {
        if (!this.multipleFacesStart) this.multipleFacesStart = now;
        if (now - this.multipleFacesStart >= 2000) {
          this.dispatchAlert("multiple_faces", `${faceCount} people detected in camera frame`);
        }
      } else {
        this.multipleFacesStart = 0;
      }

      // ── 2. Blendshapes Analysis (Face 0) ───────────────────
      const blendshapes = results.faceBlendshapes?.[0]?.categories;
      if (!blendshapes || blendshapes.length === 0) return;

      const shapes: Record<string, number> = {};
      for (const s of blendshapes) {
        shapes[s.categoryName] = s.score;
      }

      // ── 3. Eye Blinking Check ──────────────────────────────
      // Note: Automatic spoken alert for no_blinking is disabled to prevent
      // false freeze alarms when the candidate squints, concentrates, or looks down.
      const blinkLeft = shapes["eyeBlinkLeft"] || 0;
      const blinkRight = shapes["eyeBlinkRight"] || 0;
      if (blinkLeft > 0.4 || blinkRight > 0.4) {
        this.lastBlinkTimestamp = now;
      }

      const landmarks = results.faceLandmarks?.[0];

      // ── 4. Gaze & Looking Away (Head Pitch, Yaw & Eye Gaze) ──
      const lookDownLeft = shapes["eyeLookDownLeft"] || 0;
      const lookDownRight = shapes["eyeLookDownRight"] || 0;
      const avgLookDown = (lookDownLeft + lookDownRight) / 2;

      const lookOutLeft = shapes["eyeLookOutLeft"] || 0;
      const lookOutRight = shapes["eyeLookOutRight"] || 0;
      const lookSideGaze = Math.max(lookOutLeft, lookOutRight);

      const lookUpLeft = shapes["eyeLookUpLeft"] || 0;
      const lookUpRight = shapes["eyeLookUpRight"] || 0;
      const avgLookUp = (lookUpLeft + lookUpRight) / 2;

      let isLookingDown = false;
      let isSideHeadTurn = false;
      let isLookingUp = false;

      if (landmarks && landmarks.length > 263) {
        // Landmark 10: Forehead top center, Landmark 1: Nose tip, Landmark 152: Chin bottom
        const forehead = landmarks[10];
        const nose = landmarks[1];
        const chin = landmarks[152];

        const upperFaceDist = Math.max(0.005, nose.y - forehead.y);
        const lowerFaceDist = Math.max(0.001, chin.y - nose.y);
        const pitchRatio = lowerFaceDist / upperFaceDist;
        const pitchDepth = chin.z - forehead.z; // positive when chin recedes and forehead pitches forward

        // Landmark 33: left eye corner, Landmark 263: right eye corner, Landmark 168: nose bridge
        const leftEyeSpan = Math.abs(landmarks[33].x - landmarks[168].x);
        const rightEyeSpan = Math.abs(landmarks[263].x - landmarks[168].x);
        const yawRatio = leftEyeSpan / Math.max(0.001, rightEyeSpan);

        // Head pitch down or eye gaze down (looking at phone, desk, or keyboard)
        isLookingDown =
          avgLookDown > 0.22 ||
          pitchRatio < 0.68 ||
          pitchDepth > 0.035 ||
          (avgLookDown > 0.14 && pitchRatio < 0.76);

        // Head yaw or eye gaze to side screen
        isSideHeadTurn = yawRatio > 1.85 || yawRatio < 0.54;
        isLookingUp = avgLookUp > 0.38 || pitchRatio > 1.85;
      } else {
        isLookingDown = avgLookDown > 0.26;
        isLookingUp = avgLookUp > 0.40;
      }

      const isLookingAway = isLookingDown || isSideHeadTurn || lookSideGaze > 0.45 || isLookingUp;

      if (isLookingAway) {
        this.lookingAwayLastSeen = now;
        if (!this.lookingAwayStart) this.lookingAwayStart = now;
        if (now - this.lookingAwayStart >= 4500) {
          const detail = isLookingDown
            ? "Candidate looking down away from screen (phone, desk, or notes)"
            : isLookingUp
              ? "Candidate looking up away from screen"
              : "Candidate looking away from screen (secondary monitor or side view)";
          this.dispatchAlert("looking_away", detail);
          this.lookingAwayStart = 0;
        }
      } else {
        // 500ms grace period to avoid momentary flicker resetting the timer
        if (now - (this.lookingAwayLastSeen || 0) > 500) {
          this.lookingAwayStart = 0;
        }
      }

      // ── 5. Legacy Face Identity Verification (if vector is geometric) ──
      if (
        landmarks &&
        this.referenceFaceVector &&
        this.referenceFaceVector.length > 0 &&
        this.referenceFaceVector.length < 128
      ) {
        const currentVector = extractFaceBiometricVector(landmarks);
        if (currentVector) {
          const sim = compareFaceVectors(this.referenceFaceVector, currentVector);
          if (sim < 0.72) {
            if (!this.faceMismatchStart) this.faceMismatchStart = now;
            if (now - this.faceMismatchStart >= 3500) {
              this.dispatchAlert(
                "face_mismatch",
                `Face identity mismatch detected (biometric similarity ${(sim * 100).toFixed(0)}%, does not match onboarding photo)`
              );
              this.faceMismatchStart = 0;
            }
          } else {
            this.faceMismatchStart = 0;
          }
        }
      }

      // ── 6. Robust Lip-Sync & Mouth vs. Audio Correlation ───
      const jawOpen = shapes["jawOpen"] || 0;
      const mouthPucker = shapes["mouthPucker"] || 0;

      let lipDistanceRatio = 0;
      if (landmarks && landmarks.length > 152) {
        // Landmark 13: inner upper lip bottom; Landmark 14: inner lower lip top
        // Landmark 10: forehead center; Landmark 152: chin bottom
        const faceHeight = Math.max(0.001, Math.abs(landmarks[152].y - landmarks[10].y));
        const lipDist = Math.abs(landmarks[14].y - landmarks[13].y);
        lipDistanceRatio = lipDist / faceHeight;
      }

      // Track recent lip opening values for dynamic movement variance
      this.recentLipOpenings.push(lipDistanceRatio);
      if (this.recentLipOpenings.length > 12) {
        this.recentLipOpenings.shift();
      }

      // Compute variance of lip distance over recent frames
      let lipVariance = 0;
      if (this.recentLipOpenings.length >= 4) {
        const mean =
          this.recentLipOpenings.reduce((a, b) => a + b, 0) / this.recentLipOpenings.length;
        lipVariance =
          this.recentLipOpenings.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
          this.recentLipOpenings.length;
      }

      // Candidate's mouth is active if jaw is open, mouth puckered, lip aperture wide, or lips articulating
      const mouthActive =
        jawOpen > 0.03 ||
        mouthPucker > 0.05 ||
        lipDistanceRatio > 0.035 ||
        lipVariance > 0.00008;

      // Check microphone voice energy (RMS scaled level > 0.025 captures natural speech)
      const speechAudioActive = this.currentAudioLevel > 0.025;

      // Track speech audio frames vs mouth movement in a rolling buffer (25 frames = 2.5s window)
      this.recentAudioSpeechFrames.push(speechAudioActive);
      this.recentMouthActiveFrames.push(mouthActive);
      if (this.recentAudioSpeechFrames.length > 25) {
        this.recentAudioSpeechFrames.shift();
        this.recentMouthActiveFrames.shift();
      }

      if (this.recentAudioSpeechFrames.length >= 15) {
        const audioSpeechCount = this.recentAudioSpeechFrames.filter(Boolean).length;
        const mouthActiveCount = this.recentMouthActiveFrames.filter(Boolean).length;

        // Sustained audio speech (>60% of window) while mouth is motionless (<=15% of window)
        const isSustainedAudio = audioSpeechCount >= Math.round(this.recentAudioSpeechFrames.length * 0.6);
        const isMouthStationary = mouthActiveCount <= Math.round(this.recentAudioSpeechFrames.length * 0.15);

        if (isSustainedAudio && isMouthStationary) {
          this.dispatchAlert(
            "lip_sync_mismatch",
            "Microphone speech detected while mouth is not moving (possible external speaker or piped audio)"
          );
          // Clear rolling buffer after triggering to avoid repeat fires in same window
          this.recentAudioSpeechFrames = [];
          this.recentMouthActiveFrames = [];
        }
      }

      // ── 6. Liveness Hand-Wave Check ────────────────────────
      // If waiting for hand wave challenge and face is briefly obstructed or motion detected
      if (this.expectingHandWave) {
        // Fast pixel change over face area indicates hand wave
        this.checkHandWavePixelMotion(video);
      }
    } catch {
      // Frame skip
    }
  }

  private prevFacePixelSample: number[] | null = null;
  /** Fast pixel-difference check for hand crossing over face */
  private checkHandWavePixelMotion(video: HTMLVideoElement): void {
    if (!this.canvasCtx || !this.canvasElement) return;
    try {
      this.canvasCtx.drawImage(video, 0, 0, 160, 120);
      const imgData = this.canvasCtx.getImageData(40, 30, 80, 60); // center face area
      const data = imgData.data;

      if (!this.prevFacePixelSample) {
        this.prevFacePixelSample = Array.from(data.slice(0, 100));
        return;
      }

      let diff = 0;
      for (let i = 0; i < 100; i += 4) {
        diff += Math.abs(data[i] - this.prevFacePixelSample[i]);
      }

      if (diff > 2500) {
        // Significant obstruction/motion over face -> hand wave passed!
        this.expectingHandWave = false;
        this.prevFacePixelSample = null;
        this.dispatchAlert("hand_wave_verified", "Hand wave liveness challenge successfully verified");
      }
    } catch {
      // ignore
    }
  }

  /** Resilient Canvas Fallback when WebAssembly model is not yet loaded */
  private processCanvasFallback(video: HTMLVideoElement): void {
    if (!this.canvasCtx || !this.canvasElement) return;
    try {
      this.canvasCtx.drawImage(video, 0, 0, 160, 120);
      const imgData = this.canvasCtx.getImageData(0, 0, 160, 120);
      const data = imgData.data;

      // Brightness / variance check to detect complete blackout (covered camera)
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) {
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
      const avgBrightness = sum / (data.length / 16);

      const now = Date.now();
      if (avgBrightness < 12) {
        // Camera covered / pitch black
        if (!this.faceMissingStart) this.faceMissingStart = now;
        if (now - this.faceMissingStart >= 3500 && !this.isFaceMissing) {
          this.isFaceMissing = true;
          this.dispatchAlert("face_missing", "Camera feed is blacked out or covered");
        }
      } else {
        if (this.isFaceMissing) {
          this.isFaceMissing = false;
          this.faceMissingStart = 0;
          this.dispatchAlert("face_restored", "Camera feed is visible again");
        }
        this.faceMissingStart = 0;
      }
    } catch {
      // ignore
    }
  }

  /** Process using Human.js for deep neural face recognition, 3D pose, and anti-spoofing */
  private async processHumanProctor(video: HTMLVideoElement): Promise<void> {
    try {
      const res = await detectFaceWithHuman(video);
      const now = Date.now();

      // 1. Multiple Faces Detection via Human.js
      if (res.count > 1) {
        if (!this.multipleFacesStart) this.multipleFacesStart = now;
        if (now - this.multipleFacesStart >= 2000) {
          this.dispatchAlert(
            "multiple_faces",
            `${res.count} people detected in camera frame`
          );
        }
      } else {
        this.multipleFacesStart = 0;
      }

      // 2. Face Identity Verification & Baseline Auto-Lock
      if (res.hasFace && res.embedding && res.embedding.length >= 16) {
        // If baseline vector not yet loaded, auto-lock onto initial candidate face
        if (!this.referenceFaceVector && res.count === 1) {
          this.referenceFaceVector = res.embedding;
          console.info(
            `[VisionProctor] Baseline face identity locked onto candidate (vector dim: ${res.embedding.length})`
          );
        } else if (this.referenceFaceVector && this.referenceFaceVector.length > 0) {
          const sim = compareFaceVectors(this.referenceFaceVector, res.embedding);
          if (sim > 0 && sim < 0.55) {
            if (!this.faceMismatchStart) this.faceMismatchStart = now;
            if (now - this.faceMismatchStart >= 2000) {
              this.dispatchAlert(
                "face_mismatch",
                `Face identity mismatch detected (similarity ${(sim * 100).toFixed(0)}%, does not match candidate photo)`
              );
              this.faceMismatchStart = 0;
            }
          } else {
            this.faceMismatchStart = 0;
          }
        }
      }

      // 2. 3D Euler Angle Head Pose & Gaze (Yaw, Pitch)
      if (res.rotation) {
        const { yaw, pitch } = res.rotation;
        const isLookingSide = Math.abs(yaw) > 0.45; // ~26 degrees
        const isLookingDown = pitch < -0.35; // looking down at phone
        const isLookingUp = pitch > 0.42;

        if (isLookingSide || isLookingDown || isLookingUp) {
          if (!this.lookingAwayStart) this.lookingAwayStart = now;
          if (now - this.lookingAwayStart >= 4500) {
            const detail = isLookingDown
              ? "Candidate looking down away from screen (phone, desk, or notes)"
              : isLookingUp
              ? "Candidate looking up away from screen"
              : "Candidate looking away from screen (secondary monitor or side view)";
            this.dispatchAlert("looking_away", detail);
            this.lookingAwayStart = 0;
          }
        }
      }

      // 3. Deep Anti-Spoofing & Liveness Check
      if (res.antispoofScore != null && res.antispoofScore < 0.22 && res.hasFace) {
        if (!this.spoofAlertStart) this.spoofAlertStart = now;
        if (now - this.spoofAlertStart >= 3500) {
          this.dispatchAlert(
            "no_blinking",
            "Synthetic visual replay or photo spoof detected on webcam"
          );
          this.spoofAlertStart = 0;
        }
      } else {
        this.spoofAlertStart = 0;
      }
    } catch {
      // non-blocking
    }
  }

  /** Rate-limited alert dispatcher */
  private dispatchAlert(type: ProctorAlertType, detail?: string): void {
    const now = Date.now();
    const lastDispatched = this.alertCooldowns[type] || 0;

    // Cooldown rules:
    // face_restored and hand_wave_verified: 20 seconds cooldown to prevent repeated interruptions
    // other warnings: 15 seconds cooldown to avoid repetitive spamming
    const cooldown = type === "face_restored" ? 20_000 : type === "hand_wave_verified" ? 5_000 : 25_000;

    if (now - lastDispatched >= cooldown) {
      this.alertCooldowns[type] = now;
      this.onAlert({
        type,
        timestamp: now,
        detail,
      });
    }
  }
}

