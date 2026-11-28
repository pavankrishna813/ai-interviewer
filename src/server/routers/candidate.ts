import { nanoid } from "@/lib/id";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
    assertMinRole, filterAccessibleProjectIds,
    getEffectiveProjectRole, getOrgMembership, hasProjectAccess, protectedProcedure, publicProcedure, router, type MemberRole
} from "../trpc";
const candidateFields = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  gender: z.string().optional(),
  birthday: z.string().optional(),
  notes: z.string().optional(),
  education: z.string().optional(),
  school: z.string().optional(),
  major: z.string().optional(),
  graduationYear: z.number().int().optional(),
  workExperience: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/*  Helper: verify interview access via org membership                 */
/* ------------------------------------------------------------------ */

async function verifyInterviewAccess(
  supabase: Parameters<typeof getOrgMembership>[0],
  interviewId: string,
  userId: string,
): Promise<{ role: MemberRole; interviewUserId: string; organizationId: string }> {
  const { data: interview } = await supabase
    .from("interviews")
    .select("userId, projectId, project:projects!inner(organizationId)")
    .eq("id", interviewId)
    .single();

  if (!interview) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
  }

  const project = interview.project as unknown as {
    organizationId: string;
  };

  const membership = await getOrgMembership(
    supabase,
    project.organizationId,
    userId,
  );
  if (!membership) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You are not a member of this organization" });
  }

  const projAccess = await hasProjectAccess(supabase, interview.projectId, userId);
  if (!projAccess) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this project" });
  }

  const effectiveRole = await getEffectiveProjectRole(
    supabase,
    interview.projectId,
    userId,
    membership.role,
  );

  return { role: effectiveRole, interviewUserId: interview.userId, organizationId: project.organizationId };
}

interface CandidateOtpRecord {
  otp: string;
  email: string;
  expiresAt: number;
}

const candidateOtpStore = new Map<string, CandidateOtpRecord>();

function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const parts = email.trim().split("@");
  if (parts.length < 2) return email;
  const [local, domain] = parts;
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

async function dispatchCandidateOtpEmail(params: {
  email: string;
  candidateName: string;
  interviewTitle: string;
  otp: string;
}) {
  const backendBase = (
    process.env.TROVEN_API_URL ||
    process.env.NEXT_PUBLIC_TROVEN_API_URL ||
    "https://trovenbackend.smartinternz.com"
  ).replace(/\/$/, "");

  // Candidate OTP endpoints in priority order (standalone public endpoint first)
  const candidateEndpoints = [
    `${backendBase}/public/sendCandidateInviteOtp`,
    "https://trovenbackend.smartinternz.com/public/sendCandidateInviteOtp",
    `${backendBase}/thesmartbridge/talent/admin/dashboard/public/sendCandidateInviteOtp`,
  ];

  for (const endpoint of candidateEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: params.email,
          candidateName: params.candidateName,
          interviewTitle: params.interviewTitle,
          otp: params.otp,
        }),
      });
      if (res.ok) {
        console.log(`[CANDIDATE_OTP] Dispatched OTP email to ${params.email} via Troven backend (${endpoint})`);
        return true;
      }
    } catch (err) {
      console.warn(`[CANDIDATE_OTP] Troven backend dispatch warning (${endpoint}):`, err);
    }
  }

  console.log(`[CANDIDATE_OTP] Verification code for ${params.email} (${params.candidateName}): ${params.otp}`);
  return true;
}

export const candidateRouter = router({
  create: protectedProcedure
    .input(
      z.object({ interviewId: z.string() }).merge(candidateFields),
    )
    .mutation(async ({ ctx, input }) => {
      const { interviewId, ...fields } = input;

      const { role } = await verifyInterviewAccess(
        ctx.supabase,
        interviewId,
        ctx.user.id,
      );
      assertMinRole(role, "MEMBER");

      const inviteToken = nanoid(12);
      if (fields.email === "") fields.email = undefined;

      const { data: candidate, error } = await ctx.supabase
        .from("candidates")
        .insert({
          interviewId,
          ...fields,
          email: fields.email || null,
          inviteToken,
        })
        .select("*")
        .single();

      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }

      return candidate;
    }),

  bulkCreate: protectedProcedure
    .input(
      z.object({
        interviewId: z.string(),
        candidates: z.array(candidateFields).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { interviewId, candidates } = input;

      const { role } = await verifyInterviewAccess(
        ctx.supabase,
        interviewId,
        ctx.user.id,
      );
      assertMinRole(role, "MEMBER");

      const seen = new Set<string>();
      const deduped = candidates.filter((c) => {
        const email = c.email?.trim().toLowerCase();
        if (!email) return true;
        if (seen.has(email)) return false;
        seen.add(email);
        return true;
      });

      const rows = deduped.map((c) => ({
        interviewId,
        ...c,
        email: c.email?.trim().toLowerCase() || null,
        inviteToken: nanoid(12),
      }));

      if (rows.length === 0) {
        return { created: 0, total: deduped.length };
      }

      const { data, error } = await ctx.supabase
        .from("candidates")
        .insert(rows)
        .select("*");

      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }

      return { created: data?.length ?? 0, total: deduped.length };
    }),

  list: protectedProcedure
    .input(z.object({ interviewId: z.string() }))
    .query(async ({ ctx, input }) => {
      await verifyInterviewAccess(ctx.supabase, input.interviewId, ctx.user.id);

      const { data: candidates } = await ctx.supabase
        .from("candidates")
        .select("*, session:sessions(*)")
        .eq("interviewId", input.interviewId)
        .order("createdAt", { ascending: false });

      const linkedSessionIds = (candidates ?? [])
        .map((c: { sessionId: string | null }) => c.sessionId)
        .filter(Boolean);

      let walkInQuery = ctx.supabase
        .from("sessions")
        .select("*, messages(id)")
        .eq("interviewId", input.interviewId)
        .order("createdAt", { ascending: false });

      if (linkedSessionIds.length > 0) {
        walkInQuery = walkInQuery.not(
          "id",
          "in",
          `(${linkedSessionIds.join(",")})`,
        );
      }

      const { data: sessions } = await walkInQuery;
      const walkInSessions = (sessions ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => ({
          ...s,
          _count: { messages: s.messages?.length ?? 0 },
        }),
      );

      return { candidates: candidates ?? [], walkInSessions };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        gender: z.string().optional(),
        birthday: z.string().optional(),
        notes: z.string().optional(),
        education: z.string().optional(),
        school: z.string().optional(),
        major: z.string().optional(),
        graduationYear: z.number().int().optional(),
        workExperience: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;

      // Get candidate's interview to verify access
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select("interviewId")
        .eq("id", id)
        .single();

      if (!candidate) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { role } = await verifyInterviewAccess(
        ctx.supabase,
        candidate.interviewId,
        ctx.user.id,
      );
      assertMinRole(role, "MEMBER");

      const { data: updated, error } = await ctx.supabase
        .from("candidates")
        .update({ ...fields, updatedAt: new Date().toISOString() })
        .eq("id", id)
        .select("*, session:sessions(*)")
        .single();

      if (error) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Candidate not found" });
      }

      return updated;
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select("interviewId")
        .eq("id", input.id)
        .single();

      if (!candidate) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { role } = await verifyInterviewAccess(
        ctx.supabase,
        candidate.interviewId,
        ctx.user.id,
      );
      assertMinRole(role, "MEMBER");

      // Deletion guard for MEMBER
      if (role === "MEMBER") {
        const { count } = await ctx.supabase
          .from("sessions")
          .select("*", { count: "exact", head: true })
          .eq("interviewId", candidate.interviewId)
          .in("status", ["IN_PROGRESS", "COMPLETED"]);

        if ((count ?? 0) > 0) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Cannot delete candidates from an interview with active or completed sessions. Contact an admin.",
          });
        }
      }

      await ctx.supabase.from("candidates").delete().eq("id", input.id);
      return { success: true };
    }),

  removeMany: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ ctx, input }) => {
      // Verify all belong to same interview and user has access
      const { data: candidates } = await ctx.supabase
        .from("candidates")
        .select("interviewId")
        .in("id", input.ids);

      const interviewIds = Array.from(
        new Set((candidates ?? []).map((c) => c.interviewId)),
      );

      await Promise.all(
        interviewIds.map(async (iid) => {
          const { role } = await verifyInterviewAccess(
            ctx.supabase,
            iid,
            ctx.user.id,
          );
          assertMinRole(role, "MEMBER");

          if (role === "MEMBER") {
            const { count } = await ctx.supabase
              .from("sessions")
              .select("*", { count: "exact", head: true })
              .eq("interviewId", iid)
              .in("status", ["IN_PROGRESS", "COMPLETED"]);

            if ((count ?? 0) > 0) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message:
                  "Cannot delete candidates from an interview with active or completed sessions.",
              });
            }
          }
        })
      );

      await ctx.supabase.from("candidates").delete().in("id", input.ids);
      return { deleted: input.ids.length };
    }),

  listAll: protectedProcedure
    .input(
      z.object({
        organizationId: z.string().optional(),
        projectId: z.string().optional(),
        limit: z.number().min(1).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Get org IDs for the user
      const { data: memberships } = await ctx.supabase
        .from("organization_members")
        .select("workspaceId")
        .eq("userId", ctx.user.id);

      let orgIds = (memberships ?? []).map(
        (m: { workspaceId: string }) => m.workspaceId,
      );

      if (input.organizationId) {
        if (!orgIds.includes(input.organizationId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You are not a member of this organization" });
        }
        orgIds = [input.organizationId];
      }

      if (orgIds.length === 0)
        return { candidates: [], walkInSessions: [] };

      let projectIds: string[];
      if (input.projectId) {
        const projAccess = await hasProjectAccess(ctx.supabase, input.projectId, ctx.user.id);
        projectIds = projAccess ? [input.projectId] : [];
      } else {
        const { data: projects } = await ctx.supabase
          .from("projects")
          .select("id")
          .in("organizationId", orgIds);
        const allProjIds = (projects ?? []).map((p: { id: string }) => p.id);
        projectIds = await filterAccessibleProjectIds(ctx.supabase, allProjIds, ctx.user.id);
      }

      if (projectIds.length === 0)
        return { candidates: [], walkInSessions: [] };

      const { data: userInterviews } = await ctx.supabase
        .from("interviews")
        .select("id, title")
        .in("projectId", projectIds);

      const interviewIds = (userInterviews ?? []).map(
        (i: { id: string }) => i.id,
      );
      if (interviewIds.length === 0)
        return { candidates: [], walkInSessions: [] };

      const interviewMap = Object.fromEntries(
        (userInterviews ?? []).map((i) => [i.id, i.title]),
      );

      const { data: candidates } = await ctx.supabase
        .from("candidates")
        .select(
          "*, session:sessions(*), interview:interviews!inner(id, title)",
        )
        .in("interviewId", interviewIds)
        .order("createdAt", { ascending: false })
        .limit(input.limit);

      const linkedSessionIds = (candidates ?? [])
        .map((c: { sessionId: string | null }) => c.sessionId)
        .filter(Boolean);

      let walkInQuery = ctx.supabase
        .from("sessions")
        .select(
          "*, messages(id), interview:interviews!inner(id, title)",
        )
        .in("interviewId", interviewIds)
        .order("createdAt", { ascending: false })
        .limit(input.limit);

      if (linkedSessionIds.length > 0) {
        walkInQuery = walkInQuery.not(
          "id",
          "in",
          `(${linkedSessionIds.join(",")})`,
        );
      }

      const { data: sessions } = await walkInQuery;
      const walkInSessions = (sessions ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => ({
          ...s,
          _count: { messages: s.messages?.length ?? 0 },
        }),
      );

      return {
        candidates: candidates ?? [],
        walkInSessions,
        interviewMap,
      };
    }),

  getByToken: publicProcedure
    .input(
      z.object({
        token: z.string(),
        candidateEmail: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select(
          "*, session:sessions(*), interview:interviews(*, questions(*), project:projects!inner(organization:organizations!inner(name, slug)))",
        )
        .eq("inviteToken", input.token)
        .single();

      if (!candidate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invalid invite link",
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const interview = candidate.interview as any;
      if (!interview) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Interview is no longer available",
        });
      }

      const rawEmail = candidate.email?.trim().toLowerCase() || null;
      let isAuthorized = !rawEmail; // If no email is attached, open access
      if (rawEmail && input.candidateEmail) {
        isAuthorized = input.candidateEmail.trim().toLowerCase() === rawEmail;
      }

      const orgInfo = interview.project?.organization;

      return {
        ...candidate,
        email: isAuthorized ? candidate.email : null,
        maskedEmail: maskEmail(candidate.email),
        hasRegisteredEmail: Boolean(candidate.email),
        isAuthorized,
        organizationName: orgInfo?.name || "Troven",
      };
    }),

  sendCandidateOtp: publicProcedure
    .input(
      z.object({
        token: z.string(),
        email: z.string().email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select("id, name, email, interview:interviews(title)")
        .eq("inviteToken", input.token)
        .single();

      if (!candidate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invalid invite link",
        });
      }

      if (!candidate.email) {
        return { success: true, authorized: true, candidateName: candidate.name, hasEmail: false };
      }

      const expected = candidate.email.trim().toLowerCase();
      const provided = input.email.trim().toLowerCase();

      if (expected !== provided) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Access Denied: The email address entered does not match the candidate registered for this invitation.",
        });
      }

      // Generate 6-digit numeric OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

      candidateOtpStore.set(input.token, {
        otp,
        email: expected,
        expiresAt,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const interviewTitle = (candidate.interview as any)?.title || "AI Interview";

      await dispatchCandidateOtpEmail({
        email: expected,
        candidateName: candidate.name,
        interviewTitle,
        otp,
      });

      return {
        success: true,
        candidateName: candidate.name,
        maskedEmail: maskEmail(candidate.email),
        expiresInSeconds: 600,
      };
    }),

  verifyCandidateOtp: publicProcedure
    .input(
      z.object({
        token: z.string(),
        email: z.string().email(),
        otp: z.string().min(4).max(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select("id, name, email")
        .eq("inviteToken", input.token)
        .single();

      if (!candidate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invalid invite link",
        });
      }

      if (!candidate.email) {
        return { authorized: true, candidateName: candidate.name, email: null };
      }

      const expected = candidate.email.trim().toLowerCase();
      const provided = input.email.trim().toLowerCase();

      if (expected !== provided) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Access Denied: The email address entered does not match the candidate registered for this interview invitation.",
        });
      }

      const otpRecord = candidateOtpStore.get(input.token);
      const cleanOtp = input.otp.trim();

      if (!otpRecord) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No verification code was requested or code has expired. Please request a new code.",
        });
      }

      if (Date.now() > otpRecord.expiresAt) {
        candidateOtpStore.delete(input.token);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Verification code has expired. Please request a new code.",
        });
      }

      if (otpRecord.otp !== cleanOtp) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid verification code. Please check your email and try again.",
        });
      }

      // Valid OTP: delete from store and grant authorization
      candidateOtpStore.delete(input.token);

      return {
        authorized: true,
        candidateName: candidate.name,
        email: candidate.email,
      };
    }),

  verifyCandidateIdentity: publicProcedure
    .input(
      z.object({
        token: z.string(),
        email: z.string().email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select("id, name, email")
        .eq("inviteToken", input.token)
        .single();

      if (!candidate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invalid invite link",
        });
      }

      if (!candidate.email) {
        return { authorized: true, candidateName: candidate.name };
      }

      const expected = candidate.email.trim().toLowerCase();
      const provided = input.email.trim().toLowerCase();

      if (expected !== provided) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Access Denied: The email address entered does not match the candidate registered for this interview invitation.",
        });
      }

      return { authorized: true, candidateName: candidate.name };
    }),
});
