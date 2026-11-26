import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";

const log = createLogger("webhook-dispatcher");

export interface SessionCompletedPayload {
  event: string;
  sessionId: string;
  interviewId: string;
  applicationId?: string | null;
  candidateEmail?: string | null;
  candidateName?: string | null;
  status: string;
  score?: number | null;
  summary?: string | null;
  insights?: Record<string, unknown> | null;
  recordingUrl?: string | null;
  videoRecordingUrl?: string | null;
  audioRecordingUrl?: string | null;
}

export async function dispatchSessionCompletedWebhook(
  payload: SessionCompletedPayload,
  userId?: string,
): Promise<void> {
  const tasks: Promise<void>[] = [];

  // 1. Check if candidate notes has platform metadata
  let candidateApplicationId = payload.applicationId;
  let candidateSortname: string | null = null;
  let targetWebhookUrl =
    process.env.TROVEN_WEBHOOK_URL ||
    (process.env.NEXT_PUBLIC_TROVEN_API_URL
      ? `${process.env.NEXT_PUBLIC_TROVEN_API_URL.replace(/\/$/, "")}/api/v1/webhooks/ai-interview-completed`
      : "http://localhost:8000/api/v1/webhooks/ai-interview-completed");
  let webhookSource = "ai-interviewer";

  try {
    const { data: cand } = await supabaseAdmin
      .from("candidates")
      .select("notes, email, name")
      .eq("sessionId", payload.sessionId)
      .maybeSingle();

    if (cand?.notes) {
      try {
        const parsedNotes = JSON.parse(cand.notes);
        if (parsedNotes?.applicationId) {
          candidateApplicationId = parsedNotes.applicationId;
        }
        if (parsedNotes?.sortname) {
          candidateSortname = parsedNotes.sortname;
        }
        if (parsedNotes?.webhookUrl) {
          targetWebhookUrl = parsedNotes.webhookUrl;
        } else if (parsedNotes?.platform === "skillwallet") {
          targetWebhookUrl =
            process.env.SKILLWALLET_WEBHOOK_URL ||
            "http://localhost:8001/api/v1/webhooks/ai-interview-completed";
          webhookSource = "skillwallet";
        } else if (parsedNotes?.platform === "troven") {
          webhookSource = "troven";
        }
      } catch {
        // notes was not JSON
      }
    }
  } catch (err) {
    log.warn("Could not query candidate notes for session", err);
  }

  const enrichedPayload: SessionCompletedPayload = {
    ...payload,
    applicationId: candidateApplicationId || payload.applicationId || null,
  };

  // Dispatch to platform webhook
  tasks.push(
    (async () => {
      try {
        const res = await fetch(targetWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-source": webhookSource,
          },
          body: JSON.stringify({
            ...enrichedPayload,
            sortname: candidateSortname,
          }),
        });
        if (res.ok) {
          log.info(`Dispatched session completion to ${webhookSource} (${targetWebhookUrl})`);
        } else {
          log.warn(`${webhookSource} webhook returned status ${res.status}`);
        }
      } catch (err) {
        log.warn(`Failed to connect to ${webhookSource} webhook at ${targetWebhookUrl}:`, err);
      }
    })(),
  );

  // 3. User configured webhooks in Supabase
  if (userId) {
    tasks.push(
      (async () => {
        try {
          const { data: webhooks } = await supabaseAdmin
            .from("webhooks")
            .select("url, secret, events, isActive")
            .eq("userId", userId)
            .eq("isActive", true);

          for (const wh of webhooks ?? []) {
            if (Array.isArray(wh.events) && (wh.events.includes("session.completed") || wh.events.includes("*"))) {
              try {
                await fetch(wh.url, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-webhook-secret": wh.secret,
                  },
                  body: JSON.stringify(enrichedPayload),
                });
              } catch (whErr) {
                log.warn(`Failed to notify webhook ${wh.url}:`, whErr);
              }
            }
          }
        } catch (whDbErr) {
          log.warn("Error querying user webhooks:", whDbErr);
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);
}
