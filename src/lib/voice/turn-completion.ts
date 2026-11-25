// Turn completion detection: verbal cues and incomplete thought detection
// Shared between client (Web Speech API) and server (OpenAI Voice Relay)

export const TRAILING_INCOMPLETE_WORDS = new Set([
  "because", "and", "so", "if", "which", "with", "but", "that", "or",
  "like", "where", "when", "for", "as", "to", "since", "while",
  "although", "though", "even", "unless", "until", "in", "on", "at",
  "by", "about", "into", "through", "after", "before", "between",
  "then", "using", "from", "onto", "via", "such", "plus", "whereas",
  "uh", "um", "er", "ah",
]);

export function hasTrailingIncompleteThought(text: string): boolean {
  if (!text) return false;
  const clean = text.trim().toLowerCase().replace(/[.,!?;:]+$/, "");
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const lastWord = words[words.length - 1];
  return TRAILING_INCOMPLETE_WORDS.has(lastWord);
}

export const CODING_DONE_PATTERNS = [
  /\bi(?:'m| am)\s+done\b/i,
  /\bi\s+finished\b/i,
  /\bit'?s\s+done\b/i,
  /\bthat'?s\s+(?:done|all|it)\b/i,
  /\bfinished\s+it\b/i,
  /\bdone\s+with\s+(?:it|this|the code|the problem)\b/i,
  /\bthat(?:'s|\s+is)\s+my\s+solution\b/i,
  /\b(?:i(?:'m| am)\s+finished|completed\s+the\s+code)\b/i,
  /\b(?:check|review|look\s+at)\s+(?:my\s+)?code\b/i,
  /\b(?:i\s+have|have)\s+(?:implemented|written|coded|completed)\b/i,
  /\bhere(?:'s|\s+is)\s+(?:the|my)\s+code\b/i,
  /\b(?:that|this)\s+(?:should|will)\s+do\s+it\b/i,
  /(?:代码|程序)(?:写完|完成|好了)/,
  /(?:我写完了|代码写好了)/,
];

export function isCodingDoneSignal(text: string): boolean {
  return CODING_DONE_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

export const ANSWER_DONE_PATTERNS = [
  /\bthat(?:'s|\s+is)\s+(?:all|it|my\s+answer|pretty\s+much\s+it|everything(?:\s+i\s+have)?)\b/i,
  /\bi(?:'m| am)\s+(?:done|finished)(?:\s+(?:with\s+(?:my\s+answer|this|answering)|here))?\b/i,
  /\bfinished\s+(?:my\s+answer|answering|explaining)\b/i,
  /\bwhat\s+do\s+you\s+think\b/i,
  /\bdoes\s+that\s+(?:make\s+sense|answer\s+(?:your|the)\s+question)\b/i,
  /\bready\s+for\s+(?:the\s+)?next(?:\s+question)?\b/i,
  /\b(?:we\s+can|let(?:'s|\s+us))\s+move\s+on\b/i,
  /\bthat\s+wraps\s+(?:it|up|my\s+answer|my\s+thoughts?)\b/i,
  /(?:回答完毕|我说完了|这就是我的回答|差不多就这些|可以下一题了)/,
];

export function isAnswerDoneSignal(text: string): boolean {
  if (!text) return false;
  return ANSWER_DONE_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

export const AUDIO_CONFIRMATION_PATTERNS = [
  /\bcan\s+you\s+hear\s+me\b/i,
  /\b(?:how|am\s+i|are\s+you)\s+(?:audible|able\s+to\s+hear|hearing\s+me)\b/i,
  /\b(?:how\s+)?can\s+you\s+hear\b/i,
  /\b(?:i\s+)?(?:can\s+)?hear\s+you\b/i,
  /\bloud\s+and\s+clear\b/i,
  /\bhear\s+(?:you|me)\b/i,
  /^(?:yes|yeah|sure|yep|hello|hi|ok|okay)[\s.,!]*$/i,
  /^(?:hello|hi)(?:\s+(?:there|sarah|interviewer))?[\s.,!]*$/i,
  /\b(?:what\s+is|repeat|what(?:'s|\s+was))\s+(?:the\s+)?question\b/i,
  /\bare\s+you\s+there\b/i,
  /^(?:准备好了|能听到|可以听到|您好|你好|能听清)[\s.,!]*$/,
];

export function isAudioConfirmationOrGreeting(text: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  // Real greetings, checks, and brief queries are short (<= 8 words). Long technical sentences or full questions are NEVER greetings.
  if (words.length > 8) return false;
  // Short greeting utterances (<= 4 words containing hello/hi/hey/yes/yeah/ok) are always greetings
  if (
    words.length <= 4 &&
    words.some((w) => /^(?:hello|hi|hey|yes|yeah|sure|yep|ok|okay)$/i.test(w.replace(/[^\w]/g, "")))
  ) {
    return true;
  }
  return AUDIO_CONFIRMATION_PATTERNS.some((p) => p.test(clean));
}

export interface EchoStripResult {
  cleanedText: string;
  isFullEcho: boolean;
  strippedPrefix: string;
}

/**
 * Detects and strips speaker acoustic echo (when the candidate's microphone
 * picks up the interviewer's question playing through the laptop speakers).
 * 
 * If candidate text is 100% echo, returns isFullEcho=true and cleanedText="".
 * If candidate text starts with the interviewer's question and then has the
 * candidate's own response, strips the echoed question and returns the candidate's
 * response in cleanedText.
 */
export const COMMON_ASSISTANT_UTTERANCES = [
  "Hey! Thanks for taking the time to interview today. Can you hear me loud and clear?",
  "Thanks for taking the time to interview today. Can you hear me loud and clear?",
  "Awesome, loud and clear! Today we'll be focusing on",
  "Please look into the screen",
  "Please look into the camera",
  "Excuse me, I can no longer see your face on camera. Please make sure you are sitting in front of your camera and clearly visible so we can continue the interview.",
  "I can no longer see your face on camera",
  "Please adjust your camera or lighting so you are visible",
  "Whenever you're set, we can keep going—take your time!",
  "Whenever you're set, you can keep going, take your time",
  "Take your time! Feel free to think out loud, or let me know if you'd like me to clarify anything about the question.",
  "Are you still with me? Take your time, or if you'd like to skip this question or explore a different angle, just let me know!",
  "skip this question or explore a different angle, just let me know",
  "angle, just let me know!",
  "Just checking in to make sure you can still hear me and your audio is working. Whenever you're ready, let me know, or we can move forward to the next question.",
  "Excuse me, multiple faces have been detected in your camera frame.",
  "Excuse me, the person in front of the camera does not match the registered candidate.",
  "Please ensure only you are present in the frame",
  "I noticed you switched away from the interview tab",
  "Please keep your focus centered on the screen and avoid looking away during the interview.",
  "抱歉打扰一下，镜头里检测不到您的面部。请确保您坐在摄像头正前方并保持面部可见，以便我们继续面试。",
  "抱歉打扰一下，画面中检测到了多个人脸。为了保证面试规范，请确保您独自一人在房间内参加面试。",
  "抱歉打扰一下，当前摄像头前的人脸与注册候选人信息不符，请确保本人面对摄像头以继续面试。",
  "请注意将注意力集中在屏幕上，避免视线长时间移开屏幕。",
  "抱歉打扰一下，系统检测到您切出了面试页面。面试过程中请停留在当前窗口，切勿切屏。",
];

export function stripAssistantEcho(
  candidateText: string,
  recentAssistantUtterances: string[]
): EchoStripResult {
  if (!candidateText || !candidateText.trim()) {
    return { cleanedText: "", isFullEcho: true, strippedPrefix: "" };
  }

  const allUtterances = [
    ...recentAssistantUtterances,
    ...COMMON_ASSISTANT_UTTERANCES,
  ];

  const rawTrimmed = candidateText.trim();

  // Acoustic tool leakage (e.g. "Signal question, change question index 5")
  if (/\b(?:signal\s+question|change\s+question\s+index|signal_question_change)\b/i.test(rawTrimmed)) {
    const cleaned = rawTrimmed
      .replace(/\[(?:call\s+)?[a-zA-Z0-9_]+(?:\(.*?\))?\]/gi, "")
      .replace(/\b(?:signal\s+question|change\s+question\s+index|signal_question_change)(?:\s+(?:question\s+)?index\s+\d+)?\b/gi, "")
      .trim();
    if (!cleaned || cleaned.length < 3) {
      return { cleanedText: "", isFullEcho: true, strippedPrefix: rawTrimmed };
    }
  }

  // Preserve valid brief candidate greetings and mic checks
  if (isAudioConfirmationOrGreeting(rawTrimmed)) {
    return { cleanedText: rawTrimmed, isFullEcho: false, strippedPrefix: "" };
  }

  // Tokenize candidate text into words / CJK characters with char offsets
  const tokenRegex = /[a-zA-Z0-9_]+|[\u4e00-\u9fa5]/g;
  const rawTokens: { token: string; start: number; end: number; norm: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(rawTrimmed)) !== null) {
    const norm = m[0].toLowerCase();
    rawTokens.push({
      token: m[0],
      start: m.index,
      end: m.index + m[0].length,
      norm,
    });
  }

  if (rawTokens.length === 0) {
    return { cleanedText: "", isFullEcho: true, strippedPrefix: rawTrimmed };
  }

  let bestStripEndIdx = 0;

  for (const aiText of allUtterances) {
    if (!aiText || !aiText.trim()) continue;
    const normAiTokens: string[] = [];
    let aiMatch: RegExpExecArray | null;
    tokenRegex.lastIndex = 0;
    while ((aiMatch = tokenRegex.exec(aiText)) !== null) {
      normAiTokens.push(aiMatch[0].toLowerCase());
    }
    if (normAiTokens.length === 0) continue;

    // Search for matches where candidate tokens align with AI tokens
    const firstToken = rawTokens[0]?.norm;
    const secondToken = rawTokens[1]?.norm;

    for (let aiIdx = 0; aiIdx < normAiTokens.length; aiIdx++) {
      if (normAiTokens[aiIdx] === firstToken) {
        let candIdx = 0;
        let currAiIdx = aiIdx;
        while (
          candIdx < rawTokens.length &&
          currAiIdx < normAiTokens.length &&
          rawTokens[candIdx].norm === normAiTokens[currAiIdx]
        ) {
          candIdx++;
          currAiIdx++;
        }

        // Substantial echo: >= 4 words or >= 10 CJK characters
        if (candIdx >= 4) {
          const cutCharIdx = rawTokens[candIdx - 1].end;
          if (cutCharIdx > bestStripEndIdx) {
            bestStripEndIdx = cutCharIdx;
          }
        }
      }
    }

    // Also check if candidate starts from 2nd token (in case 1st token was a filler like "uh", "um", "ah")
    if (rawTokens.length >= 5 && (firstToken === "uh" || firstToken === "um" || firstToken === "ah")) {
      for (let aiIdx = 0; aiIdx < normAiTokens.length; aiIdx++) {
        if (normAiTokens[aiIdx] === secondToken) {
          let candIdx = 1;
          let currAiIdx = aiIdx;
          while (
            candIdx < rawTokens.length &&
            currAiIdx < normAiTokens.length &&
            rawTokens[candIdx].norm === normAiTokens[currAiIdx]
          ) {
            candIdx++;
            currAiIdx++;
          }
          if (candIdx >= 5) {
            const cutCharIdx = rawTokens[candIdx - 1].end;
            if (cutCharIdx > bestStripEndIdx) {
              bestStripEndIdx = cutCharIdx;
            }
          }
        }
      }
    }
  }

  if (bestStripEndIdx > 0) {
    const strippedPrefix = rawTrimmed.slice(0, bestStripEndIdx).trim();
    let remaining = rawTrimmed.slice(bestStripEndIdx).trim();
    // Remove leading punctuation / connectors
    remaining = remaining.replace(/^[.,!?;:\-—\s]+/, "").trim();

    if (!remaining || remaining.length < 3) {
      return { cleanedText: "", isFullEcho: true, strippedPrefix };
    }
    return { cleanedText: remaining, isFullEcho: false, strippedPrefix };
  }

  // Contiguous n-gram phrase coverage across all recent assistant utterances combined.
  // Physical speaker bleed concatenates or records verbatim phrases (>= 4 consecutive words) from AI speech.
  // Genuine candidate answers use natural domain vocabulary but construct novel sentences.
  const matchedIndices = new Set<number>();
  for (const aiText of allUtterances) {
    if (!aiText || !aiText.trim()) continue;
    const normAiTokens: string[] = [];
    tokenRegex.lastIndex = 0;
    let mAi: RegExpExecArray | null;
    while ((mAi = tokenRegex.exec(aiText)) !== null) {
      normAiTokens.push(mAi[0].toLowerCase());
    }
    if (normAiTokens.length === 0) continue;

    for (let c = 0; c < rawTokens.length; c++) {
      for (let a = 0; a < normAiTokens.length; a++) {
        if (rawTokens[c].norm === normAiTokens[a]) {
          let k = 0;
          while (
            c + k < rawTokens.length &&
            a + k < normAiTokens.length &&
            rawTokens[c + k].norm === normAiTokens[a + k]
          ) {
            k++;
          }
          // Match substantial contiguous phrases: >= 4 tokens, or >= 3 tokens if they are long words (>= 4 chars)
          if (k >= 4 || (k >= 3 && rawTokens[c].norm.length >= 4)) {
            for (let idx = 0; idx < k; idx++) {
              matchedIndices.add(c + idx);
            }
          }
        }
      }
    }
  }

  const coverage = matchedIndices.size / rawTokens.length;
  // If >= 70% of tokens belong to verbatim phrases copied from assistant prompts, treat as acoustic bleed
  if (rawTokens.length >= 4 && coverage >= 0.70) {
    return { cleanedText: "", isFullEcho: true, strippedPrefix: rawTrimmed };
  }

  return { cleanedText: rawTrimmed, isFullEcho: false, strippedPrefix: "" };
}

export const REPEAT_OR_CLARIFICATION_PATTERNS = [
  /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:repeat|rephrase|clarify)(?:\s+(?:that|the\s+question|what\s+you\s+said))?\b/i,
  /\b(?:please\s+)?repeat(?:\s+(?:that|the\s+question|what\s+you\s+said|again))?\b/i,
  /\b(?:what\s+was\s+(?:the|that)\s+question|what\s+did\s+you\s+(?:just\s+)?say|say\s+that\s+again|could\s+you\s+say\s+that\s+again)\b/i,
  /\b(?:pardon(?:\s+me)?|sorry\s+(?:what|pardon|can\s+you\s+repeat)|didn'?t\s+catch\s+that)\b/i,
  /(?:can|could)\s+you\s+repeat\s+the\s+question/i,
  /(?:please\s+)?say\s+that\s+again/i,
  /(?:didn'?t|couldn'?t)\s+(?:catch|hear)\s+(?:that|what\s+you\s+said)/i,
  /(?:请再说一遍|请重复一遍|没听清|能重复一下(?:问题)?吗|什么问题|再说一次)/,
];

export function isRepeatOrClarificationRequest(text: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  return REPEAT_OR_CLARIFICATION_PATTERNS.some((p) => p.test(clean));
}

export const CANDIDATE_WRAP_UP_PATTERNS = [
  /\b(?:wrap\s+(?:it\s+)?up|wrap\s+up\s+(?:the\s+interview|this|now))\b/i,
  /\b(?:close|end|finish|stop)\s+the\s+interview\b/i,
  /\bwe\s+can\s+(?:wrap\s+up|wrap\s+it\s+up|close|end|finish|stop)(?:\s+(?:it|here|the\s+interview|now))?\b/i,
  /\bthat(?:'s|\s+is)\s+all\s+(?:for\s+today|from\s+my\s+side|i\s+have)\b/i,
  /\b(?:ready|like)\s+to\s+(?:finish|conclude|wrap\s+up|end)(?:\s+(?:the\s+interview|now))?\b/i,
  /\b(?:done|finished)\s+with\s+the\s+interview\b/i,
  /\bis\s+the\s+interview\s+(?:done|over|finished)\b/i,
  /(?:结束面试|可以结束了|面试结束|就到这里吧|我们可以结束了)/,
];

export function isCandidateWrapUpRequest(text: string): boolean {
  if (!text) return false;
  return CANDIDATE_WRAP_UP_PATTERNS.some((p) => p.test(text.trim()));
}
