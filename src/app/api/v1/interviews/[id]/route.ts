import {
  apiError,
  isAuthError,
  validateApiKey,
} from "@/lib/api-key-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { id } = await params;

  if (auth.projectIds.length === 0) {
    return apiError("NOT_FOUND", "Interview not found.", 404);
  }

  const { data: interview, error } = await supabaseAdmin
    .from("interviews")
    .select("*, questions(*), sessions(id), candidates(id)")
    .eq("id", id)
    .in("projectId", auth.projectIds)
    .order("order", { referencedTable: "questions", ascending: true })
    .maybeSingle();

  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }
  if (!interview) {
    return apiError("NOT_FOUND", "Interview not found.", 404);
  }

  const copy = { ...(interview as Record<string, unknown>) };
  const sessions = copy.sessions as { id: string }[] | null | undefined;
  const candidates = copy.candidates as { id: string }[] | null | undefined;
  delete copy.sessions;
  delete copy.candidates;

  return Response.json({
    data: {
      ...copy,
      _count: {
        sessions: Math.max(sessions?.length ?? 0, candidates?.length ?? 0),
      },
    },
  });
}

const PATCH_FIELDS = [
  "title",
  "description",
  "objective",
  "assessmentCriteria",
  "chatEnabled",
  "voiceEnabled",
  "videoEnabled",
  "aiName",
  "aiTone",
  "followUpDepth",
  "language",
  "timeLimitMinutes",
  "antiCheatingEnabled",
] as const;

type PatchField = (typeof PATCH_FIELDS)[number];

function isAssessmentCriteria(
  v: unknown,
): v is { name: string; description: string }[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (x) =>
      x &&
      typeof x === "object" &&
      typeof (x as { name: string }).name === "string" &&
      typeof (x as { description: string }).description === "string",
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { id } = await params;

  if (auth.projectIds.length === 0) {
    return apiError("NOT_FOUND", "Interview not found.", 404);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError("BAD_REQUEST", "Invalid JSON body.", 400);
  }

  const patch: Record<string, unknown> = {};

  for (const key of PATCH_FIELDS) {
    if (!(key in body)) continue;
    const val = body[key];
    if (key === "title") {
      if (typeof val !== "string" || !val.trim()) {
        return apiError("BAD_REQUEST", "title must be a non-empty string.", 400);
      }
      patch.title = val.trim();
      continue;
    }
    if (key === "assessmentCriteria") {
      if (val === null) {
        patch.assessmentCriteria = null;
        continue;
      }
      if (!isAssessmentCriteria(val)) {
        return apiError(
          "BAD_REQUEST",
          "assessmentCriteria must be an array of { name, description }.",
          400,
        );
      }
      patch.assessmentCriteria = val;
      continue;
    }
    if (
      key === "chatEnabled" ||
      key === "voiceEnabled" ||
      key === "videoEnabled" ||
      key === "antiCheatingEnabled"
    ) {
      if (typeof val !== "boolean") {
        return apiError("BAD_REQUEST", `${key} must be a boolean.`, 400);
      }
      patch[key] = val;
      continue;
    }
    if (key === "aiTone") {
      if (
        val !== "CASUAL" &&
        val !== "PROFESSIONAL" &&
        val !== "FORMAL" &&
        val !== "FRIENDLY"
      ) {
        return apiError("BAD_REQUEST", "Invalid aiTone.", 400);
      }
      patch.aiTone = val;
      continue;
    }
    if (key === "followUpDepth") {
      if (val !== "LIGHT" && val !== "MODERATE" && val !== "DEEP") {
        return apiError("BAD_REQUEST", "Invalid followUpDepth.", 400);
      }
      patch.followUpDepth = val;
      continue;
    }
    if (key === "timeLimitMinutes") {
      if (val === null) {
        patch.timeLimitMinutes = null;
        continue;
      }
      if (
        typeof val !== "number" ||
        !Number.isInteger(val) ||
        val < 1
      ) {
        return apiError(
          "BAD_REQUEST",
          "timeLimitMinutes must be a positive integer or null.",
          400,
        );
      }
      patch.timeLimitMinutes = val;
      continue;
    }
    if (key === "description" || key === "objective" || key === "aiName" || key === "language") {
      if (val !== null && typeof val !== "string") {
        return apiError("BAD_REQUEST", `${key} must be a string or null.`, 400);
      }
      patch[key as PatchField] = val;
      continue;
    }
  }

  const hasQuestions = Array.isArray(body.questions);

  if (Object.keys(patch).length === 0 && !hasQuestions) {
    return apiError("BAD_REQUEST", "No valid fields to update.", 400);
  }

  let updated = null;

  if (Object.keys(patch).length > 0) {
    const { data, error } = await supabaseAdmin
      .from("interviews")
      .update(patch)
      .eq("id", id)
      .in("projectId", auth.projectIds)
      .select()
      .maybeSingle();

    if (error) {
      return apiError("INTERNAL_ERROR", error.message, 500);
    }
    if (!data) {
      return apiError("NOT_FOUND", "Interview not found.", 404);
    }
    updated = data;
  } else {
    const { data: existing, error } = await supabaseAdmin
      .from("interviews")
      .select()
      .eq("id", id)
      .in("projectId", auth.projectIds)
      .maybeSingle();

    if (error) {
      return apiError("INTERNAL_ERROR", error.message, 500);
    }
    if (!existing) {
      return apiError("NOT_FOUND", "Interview not found.", 404);
    }
    updated = existing;
  }

  // Update questions if provided in patch payload
  if (hasQuestions && Array.isArray(body.questions)) {
    await supabaseAdmin
      .from("questions")
      .delete()
      .eq("interviewId", id);

    if (body.questions.length > 0) {
      const questionRows = [];
      for (let i = 0; i < body.questions.length; i++) {
        const q = body.questions[i] as Record<string, unknown> | null | undefined;
        if (q && typeof q === "object") {
          const text = typeof q.text === "string" ? q.text.trim() : "";
          if (text) {
            const type =
              typeof q.type === "string" &&
              [
                "OPEN_ENDED",
                "SINGLE_CHOICE",
                "MULTIPLE_CHOICE",
                "CODING",
                "WHITEBOARD",
                "RESEARCH",
              ].includes(q.type)
                ? q.type
                : "OPEN_ENDED";
            const isRequired =
              q.isRequired !== undefined
                ? Boolean(q.isRequired)
                : q.required !== undefined
                  ? Boolean(q.required)
                  : true;
            const options = Array.isArray(q.options)
              ? (q.options.filter((o) => typeof o === "string") as string[])
              : null;
            questionRows.push({
              interviewId: id,
              order: typeof q.order === "number" ? q.order : i,
              text,
              type,
              isRequired,
              options,
              probeOnShort:
                q.probeOnShort !== undefined ? Boolean(q.probeOnShort) : true,
            });
          }
        }
      }
      if (questionRows.length > 0) {
        await supabaseAdmin.from("questions").insert(questionRows);
      }
    }
  }

  return Response.json({ data: updated });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { id } = await params;

  if (auth.projectIds.length === 0) {
    return apiError("NOT_FOUND", "Interview not found.", 404);
  }

  const { data: updated, error } = await supabaseAdmin
    .from("interviews")
    .update({ isActive: false })
    .eq("id", id)
    .in("projectId", auth.projectIds)
    .select("id")
    .maybeSingle();

  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }
  if (!updated) {
    return apiError("NOT_FOUND", "Interview not found.", 404);
  }

  return Response.json({
    data: { id: updated.id, archived: true },
  });
}
