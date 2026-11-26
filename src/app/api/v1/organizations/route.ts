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

export async function POST(request: Request) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError("BAD_REQUEST", "Invalid JSON body.", 400);
  }

  const rawName = body.name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    return apiError("BAD_REQUEST", "name is required.", 400);
  }
  const name = rawName.trim();

  let slug = typeof body.slug === "string" && body.slug.trim()
    ? body.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-")
    : name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

  if (!slug) {
    slug = `org-${Date.now()}`;
  }

  // Check if organization already exists by slug or exact name
  const { data: existingOrgs } = await supabaseAdmin
    .from("organizations")
    .select("id, name, slug, createdAt, updatedAt")
    .or(`slug.eq.${slug},name.ilike.${name}`)
    .limit(1);

  if (existingOrgs && existingOrgs.length > 0) {
    const existing = existingOrgs[0];
    // Ensure default project exists for this organization
    const { data: existingProjects } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("organizationId", existing.id)
      .limit(1);

    if (!existingProjects || existingProjects.length === 0) {
      await supabaseAdmin.from("projects").insert({
        name: "Default Project",
        organizationId: existing.id,
        createdBy: auth.userId,
      });
    }

    return Response.json({ data: existing, created: false });
  }

  // Create new organization
  const { data: newOrg, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .insert({
      name,
      slug,
      ownerId: auth.userId,
    })
    .select("id, name, slug, createdAt, updatedAt")
    .single();

  if (orgErr || !newOrg) {
    return apiError("INTERNAL_ERROR", orgErr?.message || "Failed to create organization.", 500);
  }

  // Link member
  await supabaseAdmin.from("organization_members").insert({
    workspaceId: newOrg.id,
    userId: auth.userId,
  });

  // Create default project for new organization
  await supabaseAdmin.from("projects").insert({
    name: "Default Project",
    organizationId: newOrg.id,
    createdBy: auth.userId,
  });

  return Response.json({ data: newOrg, created: true }, { status: 201 });
}
