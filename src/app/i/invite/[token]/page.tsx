"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Link2Off,
  CheckCircle2,
  ShieldCheck,
  AlertCircle,
  Loader2,
  Lock,
  UserCheck,
  KeyRound,
  ArrowLeft,
  Mail,
  RefreshCw,
} from "lucide-react";
import { PreparingScreen } from "@/components/session/preparing-screen";

export const AUTH_STORAGE_KEY_PREFIX = "troven_candidate_auth_";

export default function InvitePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const token = params.token as string;
  const router = useRouter();

  const [completed, setCompleted] = useState(false);
  const [authStep, setAuthStep] = useState<"email" | "otp">("email");
  const [emailInput, setEmailInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccessMessage, setAuthSuccessMessage] = useState<string | null>(null);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const sessionCreationAttempted = useRef(false);

  const candidate = trpc.candidate.getByToken.useQuery(
    { token },
    { retry: false },
  );

  const verifyIdentity = trpc.candidate.verifyCandidateIdentity.useMutation();
  const sendCandidateOtp = trpc.candidate.sendCandidateOtp.useMutation();
  const verifyCandidateOtp = trpc.candidate.verifyCandidateOtp.useMutation();

  const createSession = trpc.session.createFromInvite.useMutation({
    onSuccess: () => {
      goToSession();
    },
    onError: (err) => {
      setAuthError(err.message || "Failed to initialize interview session.");
      setIsVerifyingOtp(false);
    },
  });

  const sessionPath = `/i/invite/${token}/session`;

  useEffect(() => {
    router.prefetch(sessionPath);
  }, [router, sessionPath]);

  const goToSession = useCallback(() => {
    router.push(sessionPath);
  }, [router, sessionPath]);

  // Resend countdown timer
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setInterval(() => {
      setResendCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCountdown]);

  // Prefill email if provided in query params
  useEffect(() => {
    const queryEmail = searchParams.get("email")?.trim().toLowerCase();
    if (queryEmail && !emailInput) {
      setEmailInput(queryEmail);
    }
  }, [searchParams, emailInput]);

  // Check existing session authorization (sessionStorage or if candidate has no registered email)
  useEffect(() => {
    if (!candidate.data) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cData = candidate.data as any;

    if (!cData.hasRegisteredEmail) {
      // Candidate was added without an email requirement
      setIsAuthorized(true);
      return;
    }

    const storageKey = AUTH_STORAGE_KEY_PREFIX + token;
    let cachedEmail: string | null = null;
    try {
      cachedEmail = sessionStorage.getItem(storageKey);
    } catch {
      // Storage unavailable
    }

    if (cachedEmail) {
      verifyIdentity
        .mutateAsync({ token, email: cachedEmail })
        .then(() => {
          setIsAuthorized(true);
        })
        .catch(() => {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            // Storage unavailable
          }
          setIsAuthorized(false);
        });
    }
  }, [candidate.data, token]);

  // Handle session start once authorized
  useEffect(() => {
    if (!candidate.data || !isAuthorized || completed) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (candidate.data as any).session;
    if (session) {
      if (session.status === "COMPLETED") {
        setCompleted(true);
      } else {
        goToSession();
      }
      return;
    }

    if (!sessionCreationAttempted.current) {
      sessionCreationAttempted.current = true;
      let verifiedEmail: string | undefined = undefined;
      try {
        verifiedEmail = sessionStorage.getItem(AUTH_STORAGE_KEY_PREFIX + token) || undefined;
      } catch {
        // Storage unavailable
      }
      createSession.mutate({ inviteToken: token, candidateEmail: verifiedEmail });
    }
  }, [candidate.data, isAuthorized, completed, createSession, token, goToSession]);

  // Step 1: Submit email to request OTP
  const handleSendOtpSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = emailInput.trim().toLowerCase();
    if (!trimmed) {
      setAuthError("Please enter your registered email address.");
      return;
    }

    setAuthError(null);
    setAuthSuccessMessage(null);
    setIsSendingOtp(true);

    try {
      const res = await sendCandidateOtp.mutateAsync({ token, email: trimmed });
      if (res?.authorized && !res.hasEmail) {
        setIsAuthorized(true);
        return;
      }
      setAuthStep("otp");
      setResendCountdown(60);
      setAuthSuccessMessage(`Verification code sent to ${res.maskedEmail || trimmed}`);
    } catch (err: any) {
      setAuthError(
        err.message ||
          "Access Denied: The email address entered does not match the candidate registered for this invitation.",
      );
    } finally {
      setIsSendingOtp(false);
    }
  };

  // Step 2: Submit OTP for identity authorization
  const handleVerifyOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = emailInput.trim().toLowerCase();
    const trimmedOtp = otpInput.trim();

    if (!trimmedOtp) {
      setAuthError("Please enter the 6-digit verification code.");
      return;
    }

    if (trimmedOtp.length < 6) {
      setAuthError("Please enter the complete 6-digit verification code.");
      return;
    }

    setAuthError(null);
    setIsVerifyingOtp(true);

    try {
      await verifyCandidateOtp.mutateAsync({
        token,
        email: trimmedEmail,
        otp: trimmedOtp,
      });

      try {
        sessionStorage.setItem(AUTH_STORAGE_KEY_PREFIX + token, trimmedEmail);
      } catch {
        // Storage unavailable
      }

      setIsAuthorized(true);
      createSession.mutate({ inviteToken: token, candidateEmail: trimmedEmail });
    } catch (err: any) {
      setAuthError(
        err.message ||
          "Invalid or expired verification code. Please check your email and try again.",
      );
      setIsVerifyingOtp(false);
    }
  };

  // Loading
  if (candidate.isLoading) {
    return <PreparingScreen />;
  }

  // Error / invalid token
  if (candidate.isError || !candidate.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md shadow-lg border border-slate-200">
          <CardContent className="py-12 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <Link2Off className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold tracking-tight text-slate-900">Invalid Invite Link</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This invite link is invalid, expired, or the interview is no longer available.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Completed
  if (completed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md shadow-lg border border-slate-200">
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-500" />
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">Interview Completed</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your interview session has already been completed successfully. We appreciate your
              time and thoughtful responses.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cData = candidate.data as any;
  const interview = cData.interview;
  const orgName = cData.organizationName || "Troven";

  // Authorization Gate (Email Verification + OTP Step)
  if (cData.hasRegisteredEmail && !isAuthorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
        <Card className="w-full max-w-md border border-slate-200/80 shadow-xl dark:border-slate-800">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-500/20">
              {authStep === "otp" ? <KeyRound className="h-6 w-6" /> : <Lock className="h-6 w-6" />}
            </div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200/60 mx-auto mb-2 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/60">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>
                {authStep === "otp" ? "Step 2 of 2: OTP Verification" : "Private Candidate Invitation"}
              </span>
            </div>
            <CardTitle className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              {interview?.title || "AI Interview"}
            </CardTitle>
            <CardDescription className="text-xs text-slate-500">
              Organization: <span className="font-semibold text-slate-700 dark:text-slate-300">{orgName}</span>
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            {/* Candidate Identity Callout */}
            <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-3.5 text-xs text-slate-600 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-slate-300 space-y-1">
              <div className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-200">
                <UserCheck className="w-4 h-4 text-blue-600" />
                <span>Invited Candidate: {cData.name}</span>
              </div>
              <p className="text-[11px] text-slate-500 pl-6">
                This interview session is private and strictly restricted. Only the invited candidate can access this interview.
              </p>
              {cData.maskedEmail && (
                <p className="text-[11px] font-medium text-blue-700 dark:text-blue-400 pl-6">
                  Authorized recipient: {cData.maskedEmail}
                </p>
              )}
            </div>

            {/* Error Message */}
            {authError && (
              <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/80 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-600" />
                <div className="leading-relaxed">{authError}</div>
              </div>
            )}

            {/* Success Message */}
            {authSuccessMessage && (
              <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/80 p-3 text-xs text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
                <div className="leading-relaxed">{authSuccessMessage}</div>
              </div>
            )}

            {/* STEP 1: Email Address Verification */}
            {authStep === "email" ? (
              <form onSubmit={handleSendOtpSubmit} className="space-y-4">
                <div className="space-y-1.5 text-left">
                  <Label htmlFor="candidate-email" className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Verify Registered Email Address <span className="text-red-500">*</span>
                  </Label>
                  <div className="relative">
                    <Input
                      id="candidate-email"
                      type="email"
                      placeholder="Enter your registered email address"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      disabled={isSendingOtp}
                      className="text-sm h-10 rounded-lg pr-9"
                      autoFocus
                      required
                    />
                    <Mail className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Please enter the exact email address where you received your interview invitation.
                  </p>
                </div>

                <Button
                  type="submit"
                  disabled={isSendingOtp || !emailInput.trim()}
                  className="w-full h-10 font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-sm transition"
                >
                  {isSendingOtp ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Sending Verification Code...
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4 mr-2" />
                      Verify Email & Send OTP
                    </>
                  )}
                </Button>
              </form>
            ) : (
              /* STEP 2: OTP Verification */
              <form onSubmit={handleVerifyOtpSubmit} className="space-y-4">
                <div className="space-y-1.5 text-left">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="otp-input" className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Enter 6-Digit OTP <span className="text-red-500">*</span>
                    </Label>
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep("email");
                        setAuthError(null);
                        setAuthSuccessMessage(null);
                        setOtpInput("");
                      }}
                      className="text-[11px] font-medium text-blue-600 hover:text-blue-700 hover:underline flex items-center gap-1"
                    >
                      <ArrowLeft className="w-3 h-3" />
                      Change Email
                    </button>
                  </div>

                  <Input
                    id="otp-input"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="••••••"
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    disabled={isVerifyingOtp}
                    className="text-center font-mono text-2xl tracking-[0.5em] h-12 rounded-lg font-bold"
                    autoFocus
                    required
                  />
                  <p className="text-[11px] text-slate-400">
                    Enter the 6-digit verification code sent to your registered email address. Valid for 10 minutes.
                  </p>
                </div>

                <Button
                  type="submit"
                  disabled={isVerifyingOtp || otpInput.trim().length < 6}
                  className="w-full h-10 font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-sm transition"
                >
                  {isVerifyingOtp ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Verifying Code...
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4 mr-2" />
                      Verify & Enter Interview
                    </>
                  )}
                </Button>

                <div className="flex items-center justify-between pt-1 text-xs">
                  <button
                    type="button"
                    disabled={resendCountdown > 0 || isSendingOtp}
                    onClick={() => handleSendOtpSubmit()}
                    className="text-blue-600 hover:text-blue-700 font-medium hover:underline disabled:text-slate-400 disabled:no-underline flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3 h-3 ${isSendingOtp ? "animate-spin" : ""}`} />
                    <span>{resendCountdown > 0 ? `Resend Code in ${resendCountdown}s` : "Resend Code"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthStep("email");
                      setAuthError(null);
                      setAuthSuccessMessage(null);
                      setOtpInput("");
                    }}
                    className="text-slate-500 hover:text-slate-700"
                  >
                    Back
                  </button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Creating session / Redirecting
  return <PreparingScreen />;
}
