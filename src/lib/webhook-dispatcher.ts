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
}

export async function dispatchSessionCompletedWebhook(
  payload: SessionCompletedPayload,
  userId?: string,
): Promise<void> {
  const tasks: Promise<void>[] = [];

  // 1. Check if candidate notes has troven metadata
  let candidateApplicationId = payload.applicationId;
  let candidateSortname: string | null = null;

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
      } catch {
        // notes was not JSON
      }
    }
  } catch (err) {
    log.warn("Could not query candidate notes for session", err);
  }

  // 2. Default Troven Webhook target
  const trovenWebhookUrl =
    process.env.TROVEN_WEBHOOK_URL ||
    (process.env.NEXT_PUBLIC_TROVEN_API_URL
      ? `${process.env.NEXT_PUBLIC_TROVEN_API_URL.replace(/\/$/, "")}/api/v1/webhooks/ai-interview-completed`
      : "http://localhost:8000/api/v1/webhooks/ai-interview-completed");

  const enrichedPayload: SessionCompletedPayload = {
    ...payload,
    applicationId: candidateApplicationId || payload.applicationId || null,
  };

  // Dispatch to Troven platform webhook
  tasks.push(
    (async () => {
      try {
        const res = await fetch(trovenWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-source": "ai-interviewer",
          },
          body: JSON.stringify({
            ...enrichedPayload,
            sortname: candidateSortname,
          }),
        });
        if (res.ok) {
          log.info(`Dispatched session completion to Troven (${trovenWebhookUrl})`);
        } else {
          log.warn(`Troven webhook returned status ${res.status}`);
        }
      } catch (err) {
        log.warn(`Failed to connect to Troven webhook at ${trovenWebhookUrl}:`, err);
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
