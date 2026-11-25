/**
 * Human.js Face Detection, Embedding, and Identity Matcher
 * Uses @vladmandic/human with self-hosted models in /models/human/
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let humanInstance: any = null;
let isInitializingHuman = false;

export async function getHuman(): Promise<any> {
  if (typeof window === "undefined") return null;
  if (humanInstance) return humanInstance;

  if (isInitializingHuman) {
    while (isInitializingHuman) {
      await new Promise((r) => setTimeout(r, 60));
    }
    return humanInstance;
  }

  isInitializingHuman = true;
  try {
    const { Human } = await import("@vladmandic/human");
    const human = new Human({
      backend: "webgl",
      modelBasePath: "/models/human",
      async: false,
      filter: { enabled: true, equalization: false },
      face: {
        enabled: true,
        detector: {
          return: false,
          rotation: true,
          maxDetected: 4,
          minConfidence: 0.25,
          skipFrames: 0,
          skipTime: 0,
        },
        mesh: { enabled: true, skipFrames: 0, skipTime: 0 },
        iris: { enabled: true },
        description: {
          enabled: true,
          minConfidence: 0.1,
          skipFrames: 0,
          skipTime: 0,
        },
        emotion: { enabled: false },
        antispoof: { enabled: true, skipFrames: 0, skipTime: 0 },
        liveness: { enabled: true, skipFrames: 0, skipTime: 0 },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      segmentation: { enabled: false },
    });

    await human.load();
    await human.warmup();
    humanInstance = human;
  } catch (err) {
    console.warn("[HumanCheck] Failed to initialize Human.js:", err);
  } finally {
    isInitializingHuman = false;
  }

  return humanInstance;
}

export interface HumanFaceCheckResult {
  hasFace: boolean;
  count: number;
  embedding?: number[];
  antispoofScore?: number;
  livenessScore?: number;
  rotation?: { pitch: number; yaw: number; roll: number };
  landmarks?: Array<[number, number, number]>;
  reason?: string;
}

export async function detectFaceWithHuman(
  element: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
): Promise<HumanFaceCheckResult> {
  const human = await getHuman();
  if (!human) {
    return { hasFace: false, count: 0, reason: "Vision engine unavailable" };
  }

  try {
    const res = await human.detect(element);
    const faces = res.face || [];

    if (faces.length === 0) {
      return {
        hasFace: false,
        count: 0,
        reason: "No face detected in camera frame. Please align your face clearly with the camera.",
      };
    }

    const primaryFace = faces[0];
    const embedding = primaryFace.embedding
      ? Array.from(primaryFace.embedding as Float32Array)
      : undefined;

    return {
      hasFace: true,
      count: faces.length,
      embedding,
      antispoofScore: primaryFace.real ?? primaryFace.antispoof?.score,
      livenessScore: primaryFace.live ?? primaryFace.liveness?.score,
      rotation: primaryFace.rotation?.angle,
      landmarks: primaryFace.mesh,
    };
  } catch (err) {
    console.error("[HumanCheck] Detection error:", err);
    return { hasFace: false, count: 0, reason: "Detection failed" };
  }
}

/**
 * Compare two 512-D or 1024-D neural face embeddings using Cosine Similarity.
 * Returns similarity from 0.0 (different person) to 1.0 (identical person).
 */
export function compareFaceEmbeddings(
  a: number[] | Float32Array | null | undefined,
  b: number[] | Float32Array | null | undefined
): number {
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
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, cosine));
}

