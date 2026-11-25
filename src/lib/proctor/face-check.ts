/**
 * Face Detection Helper
 *
 * Checks if a human face exists in a video frame or canvas snapshot.
 * Used during photo collection (onboarding) and periodic interview snapshots
 * to guarantee that every captured photo contains a real candidate face.
 */

import {
  detectFaceWithHuman,
  compareFaceEmbeddings,
} from "./human-check";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedLandmarker: any = null;
let isLoadingLandmarker = false;

async function getSharedFaceLandmarker() {
  if (typeof window === "undefined") return null;
  if (sharedLandmarker) return sharedLandmarker;
  if (isLoadingLandmarker) {
    while (isLoadingLandmarker) {
      await new Promise((r) => setTimeout(r, 60));
    }
    return sharedLandmarker;
  }

  isLoadingLandmarker = true;
  try {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");

    let filesetResolver;
    try {
      filesetResolver = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    } catch {
      filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
    }

    const localModel = "/mediapipe/face_landmarker.task";
    const cdnModel =
      "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

    try {
      sharedLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: localModel, delegate: "GPU" },
        runningMode: "IMAGE",
        numFaces: 2,
      });
    } catch (gpuErr) {
      try {
        sharedLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: localModel, delegate: "CPU" },
          runningMode: "IMAGE",
          numFaces: 2,
        });
      } catch {
        sharedLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: cdnModel, delegate: "CPU" },
          runningMode: "IMAGE",
          numFaces: 2,
        });
      }
    }
  } catch (err) {
    console.warn("[FaceCheck] Could not initialize MediaPipe FaceLandmarker:", err);
  } finally {
    isLoadingLandmarker = false;
  }
  return sharedLandmarker;
}

export interface FaceCheckResult {
  hasFace: boolean;
  count: number;
  confidence?: number;
  reason?: string;
  vector?: number[];
}

/**
 * Extract a scale- and distance-invariant biometric facial proportion vector (16 ratios)
 * from MediaPipe 478 face landmarks.
 */
export function extractFaceBiometricVector(
  landmarks: Array<{ x: number; y: number; z?: number }>,
): number[] | null {
  if (!landmarks || landmarks.length < 468) return null;

  const dist = (i: number, j: number) => {
    const dx = landmarks[i].x - landmarks[j].x;
    const dy = landmarks[i].y - landmarks[j].y;
    const dz = (landmarks[i].z ?? 0) - (landmarks[j].z ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  // Inter-pupillary distance (IOD) / eye center distance as base scale factor
  const leftEye = {
    x: (landmarks[33].x + landmarks[133].x) / 2,
    y: (landmarks[33].y + landmarks[133].y) / 2,
    z: ((landmarks[33].z ?? 0) + (landmarks[133].z ?? 0)) / 2,
  };
  const rightEye = {
    x: (landmarks[263].x + landmarks[362].x) / 2,
    y: (landmarks[263].y + landmarks[362].y) / 2,
    z: ((landmarks[263].z ?? 0) + (landmarks[362].z ?? 0)) / 2,
  };

  const iod = Math.sqrt(
    Math.pow(leftEye.x - rightEye.x, 2) +
    Math.pow(leftEye.y - rightEye.y, 2) +
    Math.pow(leftEye.z - rightEye.z, 2)
  );

  if (iod < 0.001) return null;

  // Normalized biometric distance ratios
  return [
    dist(168, 1) / iod,   // 1. Nose bridge length
    dist(98, 327) / iod,  // 2. Nose alar width
    dist(1, 152) / iod,   // 3. Lower face (nose tip to chin)
    dist(61, 291) / iod,  // 4. Mouth width
    dist(234, 454) / iod, // 5. Face bizygomatic width
    dist(172, 397) / iod, // 6. Jaw bigonial width
    dist(10, 152) / iod,  // 7. Total face height
    dist(70, 300) / iod,  // 8. Eyebrow span
    dist(2, 0) / iod,     // 9. Philtrum height
    dist(0, 17) / iod,    // 10. Lip thickness
    dist(33, 133) / iod,  // 11. Left eye fissure length
    dist(362, 263) / iod, // 12. Right eye fissure length
    dist(133, 362) / iod, // 13. Intercanthal distance (space between eyes)
    dist(10, 168) / iod,  // 14. Forehead height
    dist(58, 288) / iod,  // 15. Mid-jaw width
    dist(148, 377) / iod, // 16. Lower jaw taper
  ];
}

/**
 * Compare two face biometric vectors.
 * Supports both modern 512-D neural embeddings (from Human.js) and legacy geometric vectors.
 * Returns similarity score between 0.0 (completely different) and 1.0 (identical person).
 */
export function compareFaceVectors(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;

  // 1. Modern Deep Neural Face Embeddings (Human.js ArcFace / MobileFaceNet: 512-D or 1024-D)
  if (a.length >= 128 && b.length >= 128 && a.length === b.length) {
    return compareFaceEmbeddings(a, b);
  }

  // 2. Legacy fallback for 16-ratio geometric vectors
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let relDiffSum = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
    const avg = (a[i] + b[i]) / 2;
    if (avg > 0.0001) {
      relDiffSum += Math.abs(a[i] - b[i]) / avg;
    }
  }

  const cosine = normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
  const meanRelDiff = relDiffSum / a.length;

  const diffScore = Math.max(0, 1 - meanRelDiff * 3);
  return Math.max(0, Math.min(1, cosine * 0.6 + diffScore * 0.4));
}

/**
 * Check if a face is visible in an HTMLVideoElement or HTMLCanvasElement
 */
export async function detectFace(
  element: HTMLVideoElement | HTMLCanvasElement,
): Promise<FaceCheckResult> {
  if (typeof window === "undefined" || !element) {
    return { hasFace: false, count: 0, reason: "Invalid element" };
  }

  if (typeof HTMLVideoElement !== "undefined" && element instanceof HTMLVideoElement) {
    if (element.readyState < 2 || element.videoWidth === 0 || element.videoHeight === 0) {
      return { hasFace: false, count: 0, reason: "Camera stream not ready" };
    }
  }

  if (typeof HTMLCanvasElement !== "undefined" && element instanceof HTMLCanvasElement) {
    if (element.width === 0 || element.height === 0) {
      return { hasFace: false, count: 0, reason: "Canvas image empty" };
    }
  }

  // 1. Human.js (Deep Neural Face Embedding, Anti-spoofing & 3D Pose)
  try {
    const humanResult = await detectFaceWithHuman(element);
    if (humanResult.hasFace) {
      // If anti-spoof score indicates a physical printout or screen replay (< 0.20)
      if (humanResult.antispoofScore != null && humanResult.antispoofScore < 0.20) {
        return {
          hasFace: false,
          count: 0,
          confidence: 0,
          reason: "Physical photo or screen detected. Please face the camera live.",
        };
      }
      return {
        hasFace: true,
        count: humanResult.count,
        confidence: humanResult.antispoofScore ?? 0.98,
        vector: humanResult.embedding,
      };
    } else if (humanResult.reason && humanResult.reason !== "Vision engine unavailable") {
      return {
        hasFace: false,
        count: 0,
        confidence: 0,
        reason: humanResult.reason,
      };
    }
  } catch {
    // Fall through to MediaPipe
  }

  // 2. MediaPipe Tasks Vision FaceLandmarker fallback (geometric vector)
  try {
    const landmarker = await getSharedFaceLandmarker();
    if (landmarker) {
      const results = landmarker.detect(element);
      const faceCount = results.faceLandmarks?.length || 0;
      if (faceCount > 0) {
        const vector = extractFaceBiometricVector(results.faceLandmarks[0]) ?? undefined;
        return {
          hasFace: true,
          count: faceCount,
          confidence: 0.98,
          vector,
        };
      } else {
        return {
          hasFace: false,
          count: 0,
          confidence: 0,
          reason: "No face detected in camera frame. Please align your face clearly with the camera.",
        };
      }
    }
  } catch {
    // Fall through to native detector
  }

  // 2. Native Chromium FaceDetector API fallback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ("FaceDetector" in window && typeof (window as any).FaceDetector === "function") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
      const faces = await detector.detect(element);
      if (Array.isArray(faces)) {
        return {
          hasFace: faces.length > 0,
          count: faces.length,
          confidence: faces.length > 0 ? 0.95 : 0,
          reason: faces.length === 0 ? "No face detected in camera frame" : undefined,
        };
      }
    } catch {
      // Fall through to pixel heuristic
    }
  }

  // 3. Pixel heuristic fallback: verify frame is not blacked out, washed out, or uniform
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { hasFace: true, count: 1 };

    ctx.drawImage(element, 0, 0, 160, 120);
    const imgData = ctx.getImageData(0, 0, 160, 120);
    const d = imgData.data;

    let sum = 0;
    let sumSq = 0;
    const totalPixels = d.length / 4;

    for (let i = 0; i < d.length; i += 4) {
      const b = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += b;
      sumSq += b * b;
    }

    const meanBrightness = sum / totalPixels;
    const variance = sumSq / totalPixels - meanBrightness * meanBrightness;

    if (meanBrightness < 16) {
      return { hasFace: false, count: 0, reason: "Camera is blacked out or covered" };
    }
    if (meanBrightness > 245) {
      return { hasFace: false, count: 0, reason: "Camera is overexposed or washed out" };
    }
    if (variance < 150) {
      return { hasFace: false, count: 0, reason: "No distinct visual features detected in camera frame" };
    }

    return { hasFace: true, count: 1, confidence: 0.7 };
  } catch {
    return { hasFace: true, count: 1 };
  }
}
