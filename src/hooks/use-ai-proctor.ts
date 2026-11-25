"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  getStoredReferenceFaceVector,
  getStoredReferencePhoto,
  setStoredReferenceFaceVector,
} from "@/lib/media-stream-store";
import { getHuman } from "@/lib/proctor/human-check";

export type ProctorAlertType =
  | "face_missing"
  | "face_restored"
  | "face_mismatch"
  | "looking_away"
  | "lip_sync_mismatch"
  | "multiple_faces"
  | "no_blinking"
  | "hand_wave_verified"
  | "virtual_device_detected"
  | "page_departure"
  | "paste"
  | "multi_screen";

export interface ProctorAlertEvent {
  type: ProctorAlertType;
  timestamp: number;
  detail?: string;
}

export interface UseAiProctorOptions {
  enabled: boolean;
  cameraStream: MediaStream | null;
  videoElement?: HTMLVideoElement | null;
  audioLevel?: number;
  referenceFaceVector?: number[] | null;
  sessionId?: string;
  isCodingActive?: boolean;
  isUserTyping?: boolean;
  onProctorAlert?: (alert: ProctorAlertEvent) => void;
}

// ── Tamper-resistant storage helpers matching assessmentNew.jsx ───
export const obfuscate = (val: unknown): string => {
  try {
    return btoa(encodeURIComponent(String(val)));
  } catch {
    return String(val);
  }
};

export const deobfuscate = (val: string | null): string | null => {
  if (!val) return null;
  try {
    return decodeURIComponent(atob(val));
  } catch {
    return val;
  }
};

// ── Cosine Similarity matching assessmentNew.jsx (Lines 813-818) ───
export const cosineSimilarity = (
  a: number[] | Float32Array,
  b: number[] | Float32Array
): number => {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export function useAiProctor({
  enabled,
  cameraStream,
  videoElement,
  audioLevel = 0,
  referenceFaceVector,
  sessionId,
  isCodingActive = false,
  isUserTyping = false,
  onProctorAlert,
}: UseAiProctorOptions) {
  const [showIssuePopup, setShowIssuePopup] = useState(false);
  const [issueMessage, setIssueMessage] = useState("");
  const [issueResolved, setIssueResolved] = useState(false);
  const [isMatched, setIsMatched] = useState<boolean | null>(null);
  const [similarity, setSimilarity] = useState<number | null>(null);

  const onAlertRef = useRef(onProctorAlert);
  onAlertRef.current = onProctorAlert;

  const isCodingActiveRef = useRef(isCodingActive);
  isCodingActiveRef.current = isCodingActive;
  const isUserTypingRef = useRef(isUserTyping);
  isUserTypingRef.current = isUserTyping;

  const lookingAwayStartRef = useRef<number>(0);
  const faceMissingStartRef = useRef<number>(0);

  const storedEmbeddingRef = useRef<number[] | null>(null);
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastAlertDispatchAtRef = useRef<Record<string, number>>({});
  const isAnalyzingRef = useRef(false);

  // Initialize stored baseline vector from props, localStorage, or media-stream-store
  useEffect(() => {
    if (referenceFaceVector && referenceFaceVector.length >= 128) {
      storedEmbeddingRef.current = referenceFaceVector;
      try {
        localStorage.setItem("storedEmbedding", JSON.stringify(referenceFaceVector));
      } catch {}
      return;
    }

    try {
      const fromLocal = localStorage.getItem("storedEmbedding");
      if (fromLocal) {
        const parsed = JSON.parse(fromLocal);
        if (Array.isArray(parsed) && parsed.length >= 128) {
          storedEmbeddingRef.current = parsed;
          return;
        }
      }
    } catch {}

    const fromStore = getStoredReferenceFaceVector();
    if (fromStore && fromStore.length >= 128) {
      storedEmbeddingRef.current = fromStore;
      try {
        localStorage.setItem("storedEmbedding", JSON.stringify(fromStore));
      } catch {}
      return;
    }

    // If neural embedding is missing but reference photo exists, extract neural embedding using Human.js
    const photo = getStoredReferencePhoto();
    if (photo) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = async () => {
        try {
          const human = await getHuman();
          if (!human) return;
          const res = await human.detect(img);
          const face = res?.face?.[0];
          if (face?.embedding && face.embedding.length >= 128) {
            const emb = Array.from(face.embedding as Float32Array);
            storedEmbeddingRef.current = emb;
            setStoredReferenceFaceVector(emb);
            try {
              localStorage.setItem("storedEmbedding", JSON.stringify(emb));
            } catch {}
            console.info("[Proctor] Extracted reference embedding from stored photo (dim:", emb.length, ")");
          }
        } catch (e) {
          console.warn("[Proctor] Could not extract embedding from photo:", e);
        }
      };
      img.src = photo;
    }
  }, [referenceFaceVector]);

  // Dispatch alert to voice-relay with cooldown
  const dispatchAlert = useCallback((type: ProctorAlertType, detail?: string) => {
    const now = Date.now();
    const last = lastAlertDispatchAtRef.current[type] || 0;
    const cooldown =
      type === "face_missing" || type === "multiple_faces" || type === "face_mismatch"
        ? 8_000
        : type === "looking_away"
          ? 10_000
          : 15_000;
    if (now - last >= cooldown) {
      lastAlertDispatchAtRef.current[type] = now;
      onAlertRef.current?.({
        type,
        timestamp: now,
        detail,
      });
    }
  }, []);

  // Snapshot capture and upload matching assessmentNew.jsx
  const takeUserSnap = useCallback(
    async (typeOfDetection: string) => {
      const video = activeVideoRef.current;
      if (!video || !sessionId || sessionId === "__preview__") return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 240;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(async (blob) => {
          if (!blob) return;
          const form = new FormData();
          const fname = `violation-${typeOfDetection}-${Date.now()}.jpg`;
          form.append("file", blob, fname);
          form.append("sessionId", sessionId);
          form.append("type", "screenshot");
          form.append("filename", fname);
          await fetch("/api/session/upload", { method: "POST", body: form }).catch(() => {});
        }, "image/jpeg", 0.85);
      } catch (e) {
        console.error("[Proctor] Snapshot upload error:", e);
      }
    },
    [sessionId]
  );

  // Bind active video source (prioritizing visible cameraPipRef)
  useEffect(() => {
    if (!enabled || !cameraStream) {
      activeVideoRef.current = null;
      if (fallbackVideoRef.current) {
        fallbackVideoRef.current.srcObject = null;
        fallbackVideoRef.current.remove();
        fallbackVideoRef.current = null;
      }
      return;
    }

    if (videoElement && videoElement.readyState >= 2) {
      activeVideoRef.current = videoElement;
      return;
    }

    // Fallback: create active video in DOM with minimal opacity so Chromium renders frames
    if (!fallbackVideoRef.current) {
      const vid = document.createElement("video");
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = true;
      vid.style.position = "fixed";
      vid.style.width = "160px";
      vid.style.height = "120px";
      vid.style.bottom = "0px";
      vid.style.right = "0px";
      vid.style.opacity = "0.01";
      vid.style.pointerEvents = "none";
      vid.style.zIndex = "-1";
      document.body.appendChild(vid);
      fallbackVideoRef.current = vid;
    }

    const fallback = fallbackVideoRef.current;
    if (fallback.srcObject !== cameraStream) {
      fallback.srcObject = cameraStream;
      fallback.play().catch(() => {});
    }
    activeVideoRef.current = videoElement || fallback;

    return () => {
      if (fallbackVideoRef.current) {
        fallbackVideoRef.current.srcObject = null;
        fallbackVideoRef.current.remove();
        fallbackVideoRef.current = null;
      }
    };
  }, [enabled, cameraStream, videoElement]);

  // Check for virtual audio devices on mount
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
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
                dispatchAlert("virtual_device_detected", `Virtual audio device detected: ${d.label}`);
                return;
              }
            }
          }
        }
      })
      .catch(() => {});
  }, [enabled, dispatchAlert]);

  // Auto-dismiss issue modal 1.5 seconds after issue is resolved
  useEffect(() => {
    if (issueResolved && showIssuePopup) {
      const timer = setTimeout(() => {
        setShowIssuePopup(false);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [issueResolved, showIssuePopup]);

  // ── High-Level Detection Lifecycle from assessmentNew.jsx (Lines 1516-1870) ───
  // Runs every 2,000 ms
  useEffect(() => {
    if (!enabled || !cameraStream) return;

    let isMounted = true;
    const interval = setInterval(async () => {
      if (isAnalyzingRef.current) return;

      const video = videoElement || activeVideoRef.current || fallbackVideoRef.current;
      if (!video || video.readyState < 2 || video.paused) return;

      isAnalyzingRef.current = true;
      try {
        const human = await getHuman();
        if (!human || !isMounted) return;

        const res = await human.detect(video);
        const faces = res?.face || [];

        // ── 1. MULTIPLE FACES (assessmentNew.jsx Lines 1707-1729) ──
        if (faces.length > 1) {
          const stamp = deobfuscate(localStorage.getItem("maltiFaceDetectedTimeStamp"));
          if (!stamp || Date.now() - parseInt(stamp, 10) > 5000) {
            void takeUserSnap("multiFaces");
            localStorage.setItem("maltiFaceDetectedTimeStamp", obfuscate(Date.now()));
            const prev = parseInt(deobfuscate(localStorage.getItem("multipleFaces")) || "0", 10) || 0;
            localStorage.setItem("multipleFaces", obfuscate(prev + 1));
          }
          setShowIssuePopup(true);
          setIssueResolved(false);
          setIssueMessage(
            "Multiple people or faces detected. Please ensure you're alone and centered."
          );
          dispatchAlert(
            "multiple_faces",
            `${faces.length} people detected in camera frame`
          );
          return;
        }

        // ── 2. FACE NOT IN SCREEN (assessmentNew.jsx Lines 1731-1754) ──
        if (faces.length === 0) {
          const nowMs = Date.now();
          if (!faceMissingStartRef.current) faceMissingStartRef.current = nowMs;
          if (nowMs - faceMissingStartRef.current >= 2000) {
            const stamp = deobfuscate(localStorage.getItem("faceNotDetectedTimeStamp"));
            if (!stamp || nowMs - parseInt(stamp, 10) > 4000) {
              void takeUserSnap("faceNotInScreen");
              localStorage.setItem("faceNotDetectedTimeStamp", obfuscate(nowMs));
              const prev = parseInt(deobfuscate(localStorage.getItem("faceNotDetected")) || "0", 10) || 0;
              localStorage.setItem("faceNotDetected", obfuscate(prev + 1));
            }
            dispatchAlert(
              "face_missing",
              "Candidate face is not visible in camera frame"
            );
          }
          return;
        } else {
          faceMissingStartRef.current = 0;
        }

        // ── 3. POSE & LOOKING AWAY DETECTION ──
        const face = faces[0];
        let yawVal = 0;
        let pitchVal = 0;
        if (face?.rotation?.yaw != null) {
          yawVal = face.rotation.yaw;
        } else if (face?.rotation?.angle?.yaw != null) {
          yawVal = face.rotation.angle.yaw;
        }
        if (face?.rotation?.pitch != null) {
          pitchVal = face.rotation.pitch;
        } else if (face?.rotation?.angle?.pitch != null) {
          pitchVal = face.rotation.angle.pitch;
        }

        const absYaw = Math.abs(yawVal);
        const yawDeg = absYaw <= Math.PI ? (absYaw * 180) / Math.PI : absYaw;
        const absPitch = Math.abs(pitchVal);
        const pitchDeg = absPitch <= Math.PI ? (absPitch * 180) / Math.PI : absPitch;
        const score = face?.score ?? 1;

        // ── Looking away detection ──
        // During coding, do NOT consider the "look at the screen" condition.
        // Candidates naturally look down at their keyboard, code editor, and scratchpad.
        const coding = isCodingActiveRef.current;
        if (coding) {
          lookingAwayStartRef.current = 0;
        } else {
          const isLookingSide = yawDeg > 35;
          const isLookingDown = pitchDeg > 28;
          const isLookingAway = isLookingSide || isLookingDown;
          const nowMs = Date.now();
          if (isLookingAway) {
            if (!lookingAwayStartRef.current) lookingAwayStartRef.current = nowMs;
            if (nowMs - lookingAwayStartRef.current >= 4000) {
              const detail = isLookingDown
                ? "Candidate looking down away from screen"
                : "Candidate looking away from screen (side glance)";
              dispatchAlert("looking_away", detail);
              lookingAwayStartRef.current = 0;
            }
          } else {
            lookingAwayStartRef.current = 0;
          }
        }

        const isValidPose = score > 0.35 && yawDeg < 55;
        if (!isValidPose) {
          // Skip similarity comparison for this frame rather than triggering a false mismatch.
          return;
        }

        // ── 4. IDENTITY MATCH & FACE MISMATCH (assessmentNew.jsx Lines 1786-1854) ──
        const liveEmb = face.embedding ? Array.from(face.embedding as Float32Array) : null;
        let storedEmbedding = storedEmbeddingRef.current;

        // Auto-lock candidate baseline if not yet set
        if (
          (!storedEmbedding || storedEmbedding.length < 128) &&
          faces.length === 1 &&
          isValidPose &&
          liveEmb &&
          liveEmb.length >= 128
        ) {
          storedEmbedding = liveEmb;
          storedEmbeddingRef.current = liveEmb;
          setStoredReferenceFaceVector(liveEmb);
          try {
            localStorage.setItem("storedEmbedding", JSON.stringify(liveEmb));
          } catch {}
          console.info("[Proctor] Baseline face identity auto-locked (dim:", liveEmb.length, ")");
        }

        if (liveEmb?.length && storedEmbedding?.length && liveEmb.length === storedEmbedding.length) {
          const sim = cosineSimilarity(storedEmbedding, liveEmb);
          setSimilarity(sim);

          const coding = isCodingActiveRef.current;
          const typing = isUserTypingRef.current;
          const matchThreshold = coding || typing ? 0.30 : 0.38;

          // Match Confirmed
          if (sim >= matchThreshold) {
            setIsMatched(true);
            setIssueResolved(true);
            setIssueMessage("Identity confirmed. You may continue.");
            return;
          }

          // ISSUE: FACE MISMATCH (similarity below realistic threshold)
          if (sim < matchThreshold) {
            console.warn(
              `❌ Identity Mismatch! Score: ${sim.toFixed(4)} is below threshold ${matchThreshold}.`
            );
            const stamp = deobfuscate(localStorage.getItem("faceMismatchDetectedTimeStamp"));
            if (!stamp || Date.now() - parseInt(stamp, 10) > 5000) {
              void takeUserSnap("faceMismatch");
              localStorage.setItem("faceMismatchDetectedTimeStamp", obfuscate(Date.now()));
              const prev = parseInt(deobfuscate(localStorage.getItem("faceMismatch")) || "0", 10) || 0;
              localStorage.setItem("faceMismatch", obfuscate(prev + 1));
            }
            setIsMatched(false);
            setShowIssuePopup(true);
            setIssueResolved(false);
            setIssueMessage(
              "Face mismatch detected. Please align your face clearly with the camera."
            );
            dispatchAlert(
              "face_mismatch",
              `Face identity mismatch detected (similarity ${(sim * 100).toFixed(0)}%, does not match candidate photo)`
            );
            return;
          }
        }
      } catch (err) {
        console.error("[Proctor] Detection loop error:", err);
      } finally {
        isAnalyzingRef.current = false;
      }
    }, 2000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [enabled, cameraStream, videoElement, takeUserSnap, dispatchAlert]);

  const closeIssuePopup = useCallback(() => {
    setShowIssuePopup(false);
  }, []);

  const requestHandWaveChallenge = useCallback(() => {
    // Challenge trigger if requested
  }, []);

  return {
    showIssuePopup,
    issueMessage,
    issueResolved,
    isMatched,
    similarity,
    closeIssuePopup,
    requestHandWaveChallenge,
  };
}
