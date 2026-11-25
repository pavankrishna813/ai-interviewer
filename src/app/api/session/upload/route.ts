import { createLogger } from "@/lib/logger";
import { isS3Configured, uploadToS3 } from "@/lib/s3";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

const log = createLogger("api/session/upload");

/**
 * Persist uploaded media URL directly onto the session row so recordings and
 * screenshots are never lost if the client times out or closes the tab during
 * a long video upload.
 */
async function persistMediaToSession(params: {
  sessionId: string;
  type: "recording" | "video" | "screenshot";
  url: string;
  path: string;
  filename: string | null;
}) {
  const { sessionId, type, url, path, filename } = params;
  try {
    if (type === "recording") {
      const { error } = await supabaseAdmin
        .from("sessions")
        .update({ audioRecordingUrl: url })
        .eq("id", sessionId);
      if (error) log.warn("Failed to persist audioRecordingUrl:", error.message);
      return;
    }

    if (type === "video") {
      const { data: currentSession } = await supabaseAdmin
        .from("sessions")
        .select("insights")
        .eq("id", sessionId)
        .single();
      const currentInsights = (currentSession?.insights as Record<string, unknown>) || {};
      const { error } = await supabaseAdmin
        .from("sessions")
        .update({
          insights: {
            ...currentInsights,
            videoRecordingUrl: url,
          },
        })
        .eq("id", sessionId);
      if (error) log.warn("Failed to persist videoRecordingUrl:", error.message);
      return;
    }

    if (type === "screenshot" && filename) {
      const match = filename.match(/-(camera|screen)\.jpg$/i);
      if (!match) return;
      const shotType = match[1].toLowerCase() as "camera" | "screen";
      const { data: currentSession } = await supabaseAdmin
        .from("sessions")
        .select("screenshots")
        .eq("id", sessionId)
        .single();
      const existing = Array.isArray(currentSession?.screenshots)
        ? (currentSession.screenshots as Array<{ url: string; path: string; timestamp: string; type: string }>)
        : [];
      if (existing.some((s) => s.url === url)) return;

      const updated = [
        ...existing,
        {
          url,
          path,
          timestamp: new Date().toISOString(),
          type: shotType,
        },
      ];
      const { error } = await supabaseAdmin
        .from("sessions")
        .update({ screenshots: updated })
        .eq("id", sessionId);
      if (error) log.warn("Failed to persist screenshot:", error.message);
    }
  } catch (err) {
    log.warn("Unexpected error persisting media to session:", err);
  }
}

/**
 * Upload a file (audio recording, video recording, or screenshot) to AWS S3 (or Supabase fallback).
 *
 * Expects multipart FormData with:
 *   - file: Blob/File
 *   - sessionId: string
 *   - type: "recording" | "video" | "screenshot"
 *   - filename: string (optional, used as the storage path suffix)
 */
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as Blob | null;
    const sessionId = formData.get("sessionId") as string | null;
    const type = formData.get("type") as string | null;
    const filename = formData.get("filename") as string | null;

    if (!file || !sessionId || !type) {
      return NextResponse.json(
        { error: "Missing required fields: file, sessionId, type" },
        { status: 400 },
      );
    }

    if (type !== "recording" && type !== "screenshot" && type !== "video") {
      return NextResponse.json(
        { error: 'type must be "recording", "video", or "screenshot"' },
        { status: 400 },
      );
    }

    const defaultExt = type === "screenshot"
      ? "jpg"
      : type === "video"
      ? (file.type?.includes("mp4") ? "mp4" : "webm")
      : (file.type?.includes("mp4") || file.type?.includes("m4a") ? "m4a" : "webm");

    const storagePath = `${type}s/${sessionId}/${filename || `${Date.now()}.${defaultExt}`}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const defaultContentType = type === "screenshot"
      ? "image/jpeg"
      : type === "video"
      ? (file.type?.includes("mp4") ? "video/mp4" : "video/webm")
      : (file.type?.includes("mp4") ? "audio/mp4" : "audio/webm");

    const contentType = file.type || defaultContentType;

    // Try AWS S3 first
    if (isS3Configured) {
      try {
        const s3Result = await uploadToS3({
          key: storagePath,
          body: buffer,
          contentType,
        });

        await persistMediaToSession({
          sessionId,
          type,
          url: s3Result.url,
          path: s3Result.path,
          filename,
        });

        return NextResponse.json({
          url: s3Result.url,
          path: s3Result.path,
          bucket: s3Result.bucket,
          provider: "s3",
        });
      } catch (s3Error) {
        log.error("S3 upload failed, falling back to Supabase Storage:", s3Error);
      }
    }

    // Fallback: Supabase Storage
    const bucket = type === "screenshot" ? "screenshots" : "recordings";
    const supabasePath = `${sessionId}/${filename || `${Date.now()}.${defaultExt}`}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(supabasePath, buffer, {
        contentType,
        upsert: false,
      });

    if (uploadError) {
      log.error("Storage error:", bucket, uploadError);
      return NextResponse.json(
        { error: uploadError.message },
        { status: 500 },
      );
    }

    const { data: signedData, error: signedError } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(supabasePath, 60 * 60 * 24 * 365); // 1 year

    if (signedError || !signedData?.signedUrl) {
      log.error("Signed URL error:", bucket, signedError);
      return NextResponse.json(
        { error: "Failed to generate signed URL" },
        { status: 500 },
      );
    }

    await persistMediaToSession({
      sessionId,
      type,
      url: signedData.signedUrl,
      path: supabasePath,
      filename,
    });

    return NextResponse.json({
      url: signedData.signedUrl,
      path: supabasePath,
      bucket,
      provider: "supabase",
    });
  } catch (err) {
    log.error("Unexpected error:", err);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 },
    );
  }
}
