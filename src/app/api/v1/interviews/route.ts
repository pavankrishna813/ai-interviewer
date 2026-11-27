import {
  apiError,
  isAuthError,
  validateApiKey,
} from "@/lib/api-key-auth";
import { nanoid } from "@/lib/id";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  let limit = Number.parseInt(searchParams.get("limit") ?? "20", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  const cursor = searchParams.get("cursor") ?? undefined;
  const organizationId = searchParams.get("organizationId") ?? undefined;

  let targetProjectIds = auth.projectIds;
  if (organizationId) {
    const { data: orgProjects } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("organizationId", organizationId);
    targetProjectIds = (orgProjects ?? []).map((p) => p.id);
  }

  if (targetProjectIds.length === 0) {
    return Response.json({ data: [], cursor: null });
  }

  let query = supabaseAdmin
    .from("interviews")
    .select("*, questions(id), sessions(id)")
    .in("projectId", targetProjectIds)
    .eq("isActive", true)
    .order("updatedAt", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    const { data: cursorRow } = await supabaseAdmin
      .from("interviews")
      .select("updatedAt")
      .eq("id", cursor)
      .single();
    if (cursorRow?.updatedAt) {
      query = query.lte("updatedAt", cursorRow.updatedAt as string);
    }
  }

  const { data: raw, error } = await query;
  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }

  const rows = raw ?? [];
  const page = rows.slice(0, limit);
  const data = page.map((row) => {
    const r = { ...(row as Record<string, unknown>) };
    const questions = r.questions as { id: string }[] | null | undefined;
    const sessions = r.sessions as { id: string }[] | null | undefined;
    delete r.questions;
    delete r.sessions;
    return {
      ...r,
      _count: {
        questions: questions?.length ?? 0,
        sessions: sessions?.length ?? 0,
      },
    };
  });

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = page[page.length - 1] as { id?: string } | undefined;
    nextCursor = last?.id ?? null;
  }

  return Response.json({ data, cursor: nextCursor });
}

type AssessmentCriterion = { name: string; description: string };

function isAssessmentCriteria(
  v: unknown,
): v is AssessmentCriterion[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (x) =>
      x &&
      typeof x === "object" &&
      typeof (x as AssessmentCriterion).name === "string" &&
      typeof (x as AssessmentCriterion).description === "string",
  );
}

export async function POST(request: Request) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  if (auth.projectIds.length === 0) {
    return apiError("BAD_REQUEST", "No accessible project found for this API key.", 400);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError("BAD_REQUEST", "Invalid JSON body.", 400);
  }

  const title = body.title;
  if (typeof title !== "string" || !title.trim()) {
    return apiError("BAD_REQUEST", "title is required.", 400);
  }

  const assessmentCriteria = body.assessmentCriteria;
  if (
    assessmentCriteria !== undefined &&
    assessmentCriteria !== null &&
    !isAssessmentCriteria(assessmentCriteria)
  ) {
    return apiError("BAD_REQUEST", "assessmentCriteria must be an array of { name, description }.", 400);
  }

  let projectId = auth.projectIds[0]!;

  // If organizationName or organizationId is passed, resolve or auto-create organization & project
  const orgNameParam = typeof body.organizationName === "string" ? body.organizationName.trim() : null;
  const orgIdParam = typeof body.organizationId === "string" ? body.organizationId.trim() : null;

  if (orgIdParam) {
    const { data: orgProjects } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("organizationId", orgIdParam)
      .limit(1);

    if (orgProjects && orgProjects.length > 0) {
      projectId = orgProjects[0].id;
    } else {
      const { data: createdProj } = await supabaseAdmin
        .from("projects")
        .insert({
          name: "Default Project",
          organizationId: orgIdParam,
          createdBy: auth.userId,
        })
        .select("id")
        .single();
      if (createdProj) projectId = createdProj.id;
    }
  } else if (orgNameParam) {
    const orgSlug = orgNameParam.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `org-${Date.now()}`;
    const { data: existingOrgs } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .or(`slug.eq.${orgSlug},name.ilike.${orgNameParam}`)
      .limit(1);

    let targetOrgId = existingOrgs && existingOrgs.length > 0 ? existingOrgs[0].id : null;

    if (!targetOrgId) {
      // Auto-create organization account
      const { data: newOrg } = await supabaseAdmin
        .from("organizations")
        .insert({
          name: orgNameParam,
          slug: orgSlug,
          ownerId: auth.userId,
        })
        .select("id")
        .single();

      if (newOrg) {
        targetOrgId = newOrg.id;
        await supabaseAdmin.from("organization_members").insert({
          workspaceId: newOrg.id,
          userId: auth.userId,
        });
      }
    }

    if (targetOrgId) {
      const { data: orgProjects } = await supabaseAdmin
        .from("projects")
        .select("id")
        .eq("organizationId", targetOrgId)
        .limit(1);

      if (orgProjects && orgProjects.length > 0) {
        projectId = orgProjects[0].id;
      } else {
        const { data: createdProj } = await supabaseAdmin
          .from("projects")
          .insert({
            name: "Default Project",
            organizationId: targetOrgId,
            createdBy: auth.userId,
          })
          .select("id")
          .single();
        if (createdProj) projectId = createdProj.id;
      }
    }
  }

  const chatEnabled = typeof body.chatEnabled === "boolean" ? body.chatEnabled : true;
  const voiceEnabled = typeof body.voiceEnabled === "boolean" ? body.voiceEnabled : false;
  const videoEnabled = typeof body.videoEnabled === "boolean" ? body.videoEnabled : (voiceEnabled || Boolean(body.antiCheatingEnabled));
  const aiName = typeof body.aiName === "string" && body.aiName.trim() ? body.aiName.trim() : "Troven";
  const aiTone = body.aiTone === "CASUAL" || body.aiTone === "PROFESSIONAL" || body.aiTone === "FORMAL" || body.aiTone === "FRIENDLY" ? body.aiTone : "PROFESSIONAL";
  const followUpDepth = body.followUpDepth === "LIGHT" || body.followUpDepth === "MODERATE" || body.followUpDepth === "DEEP" ? body.followUpDepth : "MODERATE";
  const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : "en";
  const antiCheatingEnabled = typeof body.antiCheatingEnabled === "boolean" ? body.antiCheatingEnabled : false;

  let timeLimitMinutes: number | null = null;
  if (body.timeLimitMinutes !== undefined && body.timeLimitMinutes !== null) {
    if (typeof body.timeLimitMinutes !== "number" || !Number.isInteger(body.timeLimitMinutes) || body.timeLimitMinutes < 1) {
      return apiError("BAD_REQUEST", "timeLimitMinutes must be a positive integer.", 400);
    }
    timeLimitMinutes = body.timeLimitMinutes;
  }

  const insert = {
    title: title.trim(),
    description: typeof body.description === "string" ? body.description : undefined,
    objective: typeof body.objective === "string" ? body.objective : undefined,
    assessmentCriteria: assessmentCriteria ?? undefined,
    chatEnabled,
    voiceEnabled,
    videoEnabled,
    aiName,
    aiTone,
    followUpDepth,
    language,
    timeLimitMinutes,
    antiCheatingEnabled,
    projectId,
    userId: auth.userId,
    requireInvite: true,
    publicSlug: nanoid(10),
  };

  const { data: interview, error } = await supabaseAdmin
    .from("interviews")
    .insert(insert)
    .select()
    .single();

  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }

  // If questions were provided in the payload, insert them directly into the questions table
  if (Array.isArray(body.questions) && body.questions.length > 0 && interview?.id) {
    const questionRows = [];
    for (let i = 0; i < body.questions.length; i++) {
      const q = body.questions[i];
      if (q && typeof q === "object") {
        const text = typeof q.text === "string" ? q.text.trim() : "";
        if (text) {
          const type = typeof q.type === "string" && ["OPEN_ENDED", "SINGLE_CHOICE", "MULTIPLE_CHOICE", "CODING", "WHITEBOARD", "RESEARCH"].includes(q.type)
            ? q.type
            : "OPEN_ENDED";
          const isRequired = q.isRequired !== undefined ? Boolean(q.isRequired) : q.required !== undefined ? Boolean(q.required) : true;
          questionRows.push({
            interviewId: interview.id,
            order: typeof q.order === "number" ? q.order : i,
            text,
            type,
            isRequired,
            options: Array.isArray(q.options) ? q.options : null,
            probeOnShort: q.probeOnShort !== undefined ? Boolean(q.probeOnShort) : true,
          });
        }
      }
    }
    if (questionRows.length > 0) {
      await supabaseAdmin.from("questions").insert(questionRows);
    }
  }

  return Response.json({ data: interview });
}
