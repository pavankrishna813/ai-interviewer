/**
 * Module-level store for MediaStreams that need to persist across
 * client-side page navigations (e.g., onboarding → interview session).
 *
 * The "skipped" flags track when the user explicitly skipped a check
 * during onboarding, so downstream code knows not to re-prompt.
 */

let cameraStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let cameraSkipped = false;
let screenSkipped = false;
let referencePhoto: string | null = null;
let referenceFaceVector: number[] | null = null;

export function setStoredReferencePhoto(photo: string | null) {
  referencePhoto = photo;
  if (typeof window !== "undefined") {
    try {
      if (photo) {
        sessionStorage.setItem("troven_reference_photo", photo);
      } else {
        sessionStorage.removeItem("troven_reference_photo");
      }
    } catch {}
  }
}

export function getStoredReferencePhoto(): string | null {
  if (referencePhoto) return referencePhoto;
  if (typeof window !== "undefined") {
    try {
      const saved = sessionStorage.getItem("troven_reference_photo");
      if (saved) {
        referencePhoto = saved;
        return referencePhoto;
      }
    } catch {}
  }
  return null;
}

export function setStoredReferenceFaceVector(vector: number[] | null) {
  referenceFaceVector = vector;
  if (typeof window !== "undefined") {
    try {
      if (vector && Array.isArray(vector) && vector.length > 0) {
        sessionStorage.setItem("troven_reference_face_vector", JSON.stringify(vector));
      } else {
        sessionStorage.removeItem("troven_reference_face_vector");
      }
    } catch {}
  }
}

export function getStoredReferenceFaceVector(): number[] | null {
  if (referenceFaceVector && referenceFaceVector.length > 0) return referenceFaceVector;
  if (typeof window !== "undefined") {
    try {
      const saved = sessionStorage.getItem("troven_reference_face_vector");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          referenceFaceVector = parsed;
          return referenceFaceVector;
        }
      }
    } catch {}
  }
  return null;
}

export function setStoredCameraStream(stream: MediaStream | null) {
  cameraStream = stream;
  if (stream) cameraSkipped = false;
}

export function getStoredCameraStream(): MediaStream | null {
  if (cameraStream && cameraStream.active) return cameraStream;
  cameraStream = null;
  return null;
}

export function setCameraSkipped(skipped: boolean) {
  cameraSkipped = skipped;
}

export function wasCameraSkipped(): boolean {
  return cameraSkipped;
}

export function setStoredScreenStream(stream: MediaStream | null) {
  screenStream = stream;
  if (stream) screenSkipped = false;
}

export function getStoredScreenStream(): MediaStream | null {
  if (screenStream && screenStream.active) return screenStream;
  screenStream = null;
  return null;
}

export function setScreenSkipped(skipped: boolean) {
  screenSkipped = skipped;
}

export function wasScreenSkipped(): boolean {
  return screenSkipped;
}
