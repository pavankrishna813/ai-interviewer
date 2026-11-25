export const DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS = 600;
export const DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES = 48_000;

export { isWhisperHallucination } from "../src/lib/voice/hallucination-filter";
export {
  TRAILING_INCOMPLETE_WORDS,
  hasTrailingIncompleteThought,
  CODING_DONE_PATTERNS,
  isCodingDoneSignal,
  ANSWER_DONE_PATTERNS,
  isAnswerDoneSignal,
  AUDIO_CONFIRMATION_PATTERNS,
  isAudioConfirmationOrGreeting,
  stripAssistantEcho,
  type EchoStripResult,
  REPEAT_OR_CLARIFICATION_PATTERNS,
  isRepeatOrClarificationRequest,
  CANDIDATE_WRAP_UP_PATTERNS,
  isCandidateWrapUpRequest,
} from "../src/lib/voice/turn-completion";

export interface TtsBargeInDecision {
  inEchoCooldown: boolean;
  modelIsSpeaking: boolean;
  responseAudioStarted: boolean;
  ttsAudioStartedAt: number;
  nowMs: number;
  responseTtsBytes: number;
  rms: number;
  thresholdRms: number;
  consecutiveFrames: number;
  thresholdFrames: number;
  minAudioMs?: number;
  minAudioBytes?: number;
}

export function shouldAllowTtsBargeIn({
  inEchoCooldown,
  modelIsSpeaking,
  responseAudioStarted,
  ttsAudioStartedAt,
  nowMs,
  responseTtsBytes,
  rms,
  thresholdRms,
  consecutiveFrames,
  thresholdFrames,
  minAudioMs = DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS,
  minAudioBytes = DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES,
}: TtsBargeInDecision): boolean {
  // If assistant is neither speaking nor in echo cooldown, there is nothing to barge in on
  if (!inEchoCooldown && !modelIsSpeaking) return false;
  // If model audio is actively streaming from server, guard the initial attack
  if (modelIsSpeaking) {
    if (!responseAudioStarted) return false;
    if (ttsAudioStartedAt <= 0) return false;
    if (nowMs - ttsAudioStartedAt < minAudioMs) return false;
    if (responseTtsBytes < minAudioBytes) return false;
  }
  // While audio is playing or in cooldown, require genuine human vocal energy
  if (rms < thresholdRms) return false;
  if (consecutiveFrames < thresholdFrames) return false;
  return true;
}

export const FAST_NEXT_PATTERNS = [
  /^(?:下一个问题|下一题|跳过|next\s*question|skip(?:\s+this)?|move\s+(?:to\s+)?next)\.?$/i,
];

export const FAST_PREV_PATTERNS = [
  /^(?:上一个问题|上一题|previous\s*question|go\s+back)\.?$/i,
];

export const USER_SKIP_PATTERNS = [
  /(?:let'?s|please|can\s+(?:we|you))\s+(?:move\s+on|skip|proceed|go\s+to\s+(?:the\s+)?next)/i,
  /move\s+on(?:\s+to)?/i,
  /continue\s+to\s+(?:the\s+)?next/i,
  /go\s+(?:on\s+)?to\s+(?:the\s+)?next/i,
  /skip\s+(?:this|the)\s+(?:question|one|problem)/i,
  /I\s+(?:give\s+up|want\s+to\s+skip|'?d\s+like\s+to\s+skip)/i,
  /next\s+question/i,
  /please\s+(?:move\s+on|skip)/i,
  /\b(?:ready\s+for\s+(?:the\s+)?next|proceed\s+to\s+next)\b/i,
  /(?:跳过|下一(?:个问题|题)|不做了|放弃了?|结束吧|请继续(?:下一|到下))/,
  /(?:我不会|不想做了|不想答了|过吧|换下一)/,
];

export const USER_PREV_PATTERNS = [
  /(?:go|move|get)\s+back\s+(?:to\s+)?(?:the\s+)?(?:previous|last|prior)/i,
  /(?:return|go)\s+to\s+(?:the\s+)?(?:previous|last|prior)\s+(?:question|one|problem)/i,
  /(?:can|could)\s+(?:we|you|i)\s+(?:go|move|get)\s+back/i,
  /(?:let'?s|please|i\s+(?:want|need)\s+to)\s+(?:go|move|get)\s+back/i,
  /(?:revisit|re-visit)\s+(?:the\s+)?(?:previous|last|prior)/i,
  /previous\s+question/i,
  /(?:回到|返回|回去)(?:上一(?:个问题|题)|之前(?:的问题|那题))/,
  /(?:我(?:想|要|需要)|请|可以)(?:回到|返回|回去)上一/,
  /(?:^|\b)(?:上一题|上一个问题)(?:\b|$)/,
];

export function isFastNextRequest(text: string): boolean {
  const trimmed = text.trim();
  return FAST_NEXT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isFastPrevRequest(text: string): boolean {
  const trimmed = text.trim();
  return FAST_PREV_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isUserSkipRequest(text: string): boolean {
  return USER_SKIP_PATTERNS.some((pattern) => pattern.test(text));
}

export function isUserPrevRequest(text: string): boolean {
  return USER_PREV_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeFarewell(text: string, isZh: boolean): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/[?？]/.test(normalized)) return false;

  const zhPatterns = [
    /再见/,
    /保重/,
    /一路顺利/,
    /祝你(?:一切顺利|顺利|好运)/,
    /感谢你今天的参与/,
    /祝你未来(?:的)?面试顺利/,
    /面试(?:到这里|结束)/,
  ];
  const enPatterns = [
    /\bgood\s*bye\b/,
    /\bgoodbye\b/,
    /\bbye for now\b/,
    /\bthat'?s all for now\b/,
    /\ball for now\b/,
    /\btake care\b/,
    /\bbest of luck\b/,
    /\bwish you (?:the )?best\b/,
    /\bthank(?:s|\s+you)\s+(?:so\s+much\s+)?for\s+your\s+time\b/,
    /\bhave\s+a\s+(?:great|good|wonderful)\s+day\b/,
    /\bwrap(?:ping)?\s+(?:things|it|everything)\s+up\b/,
    /\bthat\s+wraps\s+up\b/,
    /\bpleasure\s+(?:speaking|talking)\s+with\s+you\b/,
    /\bfuture interviews\b/,
  ];

  const patterns = isZh ? [...zhPatterns, ...enPatterns] : [...enPatterns, ...zhPatterns];
  return patterns.some((pattern) => pattern.test(normalized));
}

export function mergeAsrText(previous: string, incoming: string): string {
  const prev = previous.trim();
  const next = incoming.trim();
  if (!next) return prev;
  if (!prev) return next;

  const prevLower = prev.toLowerCase();
  const nextLower = next.toLowerCase();

  if (nextLower.includes(prevLower)) return next;
  if (prevLower.includes(nextLower)) return prev;

  // Avoid regressing a long interim transcript into a tiny trailing fragment.
  if (next.length + 8 < prev.length) return prev;

  return next.length >= prev.length ? next : prev;
}

export function resolveTargetQuestionIndex(
  requestedIdx: number,
  currentIdx: number,
  userRequested: boolean,
  totalQuestions: number
): { targetIdx: number; autoCorrected: boolean } {
  let targetIdx = requestedIdx;
  let autoCorrected = false;

  // Auto-correct when model passes current index intending to advance (or candidate requested to advance)
  if (targetIdx === currentIdx) {
    targetIdx = currentIdx + 1;
    autoCorrected = true;
  }

  // Never allow automatic backward progression unless explicitly user-requested
  if (targetIdx < currentIdx && !userRequested) {
    targetIdx = currentIdx;
    autoCorrected = true;
  }

  return { targetIdx: Math.min(targetIdx, totalQuestions), autoCorrected };
}

// ── Proctoring Disruption & Spoken Integrity Warnings ───────────────

export interface ProctorDisruptionDecision {
  alertType: string;
  isCoding: boolean;
  nowMs: number;
  lastProctorSpokenAt: number;
  lastTypeSpokenAt: number;
  globalCooldownMs?: number;
  typeCooldownMs?: number;
}

export function shouldDisruptForProctorAlert({
  alertType,
  isCoding,
  nowMs,
  lastProctorSpokenAt,
  lastTypeSpokenAt,
  globalCooldownMs = 30_000,
  typeCooldownMs = 45_000,
}: ProctorDisruptionDecision): { shouldDisrupt: boolean; reason: string } {
  // During coding questions, do NOT consider looking_away condition
  if (alertType === "looking_away" && isCoding) {
    return { shouldDisrupt: false, reason: "suppressed_during_coding" };
  }

  const isCriticalIntegrityAlert =
    alertType === "face_missing" ||
    alertType === "multiple_faces" ||
    alertType === "face_mismatch" ||
    alertType === "page_departure";

  // Critical integrity alerts have a much shorter cooldown window (6s global playback buffer, 20s per-type)
  const effectiveGlobalCooldown = isCriticalIntegrityAlert ? 6_000 : globalCooldownMs;
  const effectiveTypeCooldown = isCriticalIntegrityAlert ? 20_000 : typeCooldownMs;

  // Enforce global cooldown to prevent stuttering/rapid-fire disruptions while an alert is still speaking
  if (nowMs - lastProctorSpokenAt < effectiveGlobalCooldown) {
    return { shouldDisrupt: false, reason: "global_cooldown" };
  }

  // Enforce per-alert-type cooldown so repeated occurrences of the same issue don't spam
  if (nowMs - lastTypeSpokenAt < effectiveTypeCooldown) {
    return { shouldDisrupt: false, reason: "type_cooldown" };
  }

  return { shouldDisrupt: true, reason: "approved" };
}

export function buildProctorWarningText(
  alertType: string,
  isZh: boolean,
  detail?: string
): string {
  switch (alertType) {
    case "face_missing":
      return isZh
        ? "抱歉打扰一下，镜头里检测不到您的面部。请确保您坐在摄像头正前方并保持面部可见，以便我们继续面试。"
        : "Excuse me, I can no longer see your face on camera. Please make sure you are sitting in front of your camera and clearly visible so we can continue the interview.";
    case "multiple_faces":
      return isZh
        ? "抱歉打扰一下，画面中检测到了多个人脸。为了保证面试规范，请确保您独自一人在房间内参加面试。"
        : "Excuse me, multiple faces have been detected in your camera frame. Please ensure that you are alone in the room to maintain interview integrity.";
    case "face_mismatch":
      return isZh
        ? "抱歉打扰一下，当前摄像头前的人脸与注册候选人信息不符，请确保本人面对摄像头以继续面试。"
        : "Excuse me, the person in front of the camera does not match the registered candidate. Please ensure the verified candidate is facing the camera directly.";
    case "looking_away":
      return isZh
        ? "请注意将注意力集中在屏幕上，避免视线长时间移开屏幕。"
        : "Please keep your focus centered on the screen and avoid looking away during the interview.";
    case "page_departure":
      return isZh
        ? "抱歉打扰一下，系统检测到您切出了面试页面。面试过程中请停留在当前窗口，切勿切屏。"
        : "Excuse me, it looks like you navigated away from the interview window. Please stay on this tab and avoid switching windows.";
    case "paste":
      return isZh
        ? "请注意，面试中禁止粘贴外部内容，请直接在界面中作答或编写代码。"
        : "Please note that pasting external content is not permitted. Please write out your response directly.";
    default:
      return isZh
        ? `抱歉打扰一下，系统检测到监考异常（${detail || alertType}）。请确保遵守面试诚信规范。`
        : `Excuse me, a proctoring issue was detected: ${detail || alertType}. Please ensure you follow the interview integrity guidelines.`;
  }
}
