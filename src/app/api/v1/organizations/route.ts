import {
  apiError,
  isAuthError,
  validateApiKey,
} from "@/lib/api-key-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  // 1. Fetch all organization memberships for this user
  const { data: memberships } = await supabaseAdmin
    .from("organization_members")
    .select("workspaceId")
    .eq("userId", auth.userId);

  const orgIds = Array.from(
    new Set([
      auth.organizationId,
      ...(memberships ?? []).map((m) => m.workspaceId),
    ]),
  ).filter(Boolean);

  // 2. Fetch owned organizations as well
  const { data: ownedOrgs } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("ownerId", auth.userId);

  const allAccessibleIds = Array.from(
    new Set([...orgIds, ...(ownedOrgs ?? []).map((o) => o.id)]),
  ).filter(Boolean);

  // 3. Query organization details
  let query = supabaseAdmin
    .from("organizations")
    .select("id, name, slug, createdAt, updatedAt")
    .order("name", { ascending: true });

  if (allAccessibleIds.length > 0) {
    query = query.in("id", allAccessibleIds);
  }

  const { data: rawOrgs, error } = await query;
  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }

  // 4. Enrich each organization with interviewCount
  const orgList = rawOrgs || [];
  const enriched = await Promise.all(
    orgList.map(async (org) => {
      const { data: projs } = await supabaseAdmin
        .from("projects")
        .select("id")
        .eq("organizationId", org.id);
      const projIds = (projs ?? []).map((p) => p.id);

      let interviewCount = 0;
      if (projIds.length > 0) {
        const { count } = await supabaseAdmin
          .from("interviews")
          .select("id", { count: "exact", head: true })
          .in("projectId", projIds);
        interviewCount = count ?? 0;
      }

      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        interviewCount,
      };
    }),
  );

  return Response.json({
    data: enriched,
  });
}
