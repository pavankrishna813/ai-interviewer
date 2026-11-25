// Whisper commonly hallucinates YouTube signoffs, subtitle credits, or
// random language switches on silence / ambient microphone noise.

const COMMON_HALLUCINATIONS = new Set([
  "thank you.",
  "thank you",
  "thanks.",
  "thanks",
  "thank you very much.",
  "thank you so much.",
  "thank you for watching.",
  "thanks for watching.",
  "thanks for watching!",
  "bye.",
  "bye",
  "goodbye.",
  "goodbye",
  "bye-bye.",
  "bye-bye",
  "bye-bye.bye-bye.",
  "bye-bye. bye-bye.",
  "bye bye",
  "okay. thank you. bye.",
  "okay thank you bye",
  "okay. thank you.",
  "ok thank you bye",
  "ok thank you",
  "thank you. bye.",
  "thank you, bye.",
  "thank you bye",
  "you",
  "the end.",
  "the end",
  "subscribe.",
  "subscribe",
  "please subscribe.",
  "like and subscribe.",
  "you're being recorded.",
  "you're being recorded.i'll see you soon.",
  "you're being recorded. i'll see you soon.",
  "it's handy.",
  "so...",
  "silence.",
  ".",
  "..",
  "...",
  " ",
  "cheers.",
  "cheers",
  "so thank the lord.",
  "so thank the lord",
  "thank the lord.",
  "thank the lord",
  "keep it closing.",
  "keep it closing",
  "see you tomorrow. bye.",
  "see you tomorrow. bye",
  "see you tomorrow.",
  "see you tomorrow",
  "see you then.",
  "see you then",
  "see you soon.",
  "see you soon",
  "see you later.",
  "see you later",
  "all right.",
  "all right",
  "all right. okay.",
  "all right okay",
  "okay all right",
  "it's a little hot in there.",
  "it's a little hot in there",
  "thank you all very much.",
  "thank you all very much",
  "thank you all so much.",
  "thank you all so much",
  "and that's all there is to it.",
  "and that's all there is to it",
  "that's all there is to it.",
  "that's all there is to it",
  "thanks for watching. bye.",
  "thanks for watching. bye",
  "see ya.",
  "see ya",
  "see ya!",
  "seeya",
  "see ya later.",
  "see ya later",
  "bye now.",
  "bye now",
  "take care.",
  "take care",
  "alright. peace.",
  "alright peace.",
  "alright peace",
  "all right peace",
  "all right. peace.",
  "yep. ok.",
  "yep. ok",
  "yep ok",
  "www.microsoft.com.",
  "www.microsoft.com",
  "microsoft.com",
  "karen.",
  "karen",
  "steve.",
  "steve",
  "commenting.",
  "commenting",
  "and many more.",
  "and many more",
  "yep.",
  "yep",
  "peace.",
  "peace",
  "it's a lot of work.",
  "it's a lot of work",
  "courses.",
  "courses",
  "and more.",
  "and more",
  "and more. thank you.",
  "and more. thank you",
  "more.",
  "more",
  "thank you very much, everybody.",
  "thank you very much, everybody",
  "thank you very much everybody.",
  "thank you very much everybody",
  "and much more. thank you.",
  "and much more. thank you",
  "much more. thank you.",
  "much more. thank you",
  "thank you very much for being here. see you next year. thank you.",
  "thank you very much for being here. see you next year. thank you",
  "thank you very much for being here.",
  "thank you very much for being here",
  "see you next year. thank you.",
  "see you next year. thank you",
  "see you next year.",
  "see you next year",
  "you know.",
  "you know",
  "it's good.",
  "it's good",
  "can we close it for a bit?",
  "can we close it for a bit",
  "can we close it?",
  "can we close it",
  "i am feeling good now.",
  "i am feeling good now",
  "i am not feeling good.",
  "i am not feeling good",
  "i don't think you can beat him.",
  "i don't think you can beat him",
  "that's an old-fashioned way to go bykeevalt and it wasn't very practical either.",
  "that's an old-fashioned way to go bykeevalt and it wasn't very practical either",
  "etc.",
  "etc",
  "much.",
  "much",
  "always.",
  "always",
  "cell hyperlinks",
  "admin desktop",
  "rearm menus",
  "administrative packages",
  "i'm steve.",
  "i'm steve",
  "im steve.",
  "im steve",
]);

const HALLUCINATION_WORD_SET = new Set([
  "okay",
  "ok",
  "thank",
  "thanks",
  "you",
  "bye",
  "goodbye",
  "byebye",
  "for",
  "watching",
  "see",
  "soon",
  "ill",
  "recorded",
  "being",
  "the",
  "end",
  "subscribe",
  "please",
  "like",
  "share",
  "welcome",
  "much",
  "very",
  "handy",
  "cheers",
  "lord",
  "sorry",
  "yeah",
  "yes",
  "tomorrow",
  "then",
  "later",
  "closing",
  "peace",
  "yep",
  "alright",
  "here",
  "next",
  "year",
]);

const ISOLATED_SILENCE_FILLERS = new Set([
  "cheers",
  "all right",
  "all right okay",
  "okay all right",
  "yeah yeah",
  "yes yes",
  "okay okay",
  "thanks thanks",
  "thank you thank you",
  "so",
]);

/**
 * Detect whether a given transcript fragment is a Whisper silence / noise hallucination.
 */
export function isWhisperHallucination(text: string, lang = "en"): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  const lower = trimmed.toLowerCase();
  if (COMMON_HALLUCINATIONS.has(lower)) return true;

  // Reject URL/domain hallucinations (e.g. https://sites.google.com, www.youtube.com, etc.)
  if (
    /https?:\/\//i.test(lower) ||
    /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i.test(lower) ||
    /\bsites\.google\b/i.test(lower) ||
    /\b[a-z0-9-]+\.(?:com|org|net|io|edu|gov|co|in)\b/i.test(lower)
  ) {
    return true;
  }

  // Reject legal/video disclaimer, description links, & platform boilerplate
  if (
    /\b(?:disclaimer|terms\s+of\s+(?:service|use)|privacy\s+policy|all\s+rights\s+reserved|copyright)\b/i.test(lower) ||
    /\b(?:please\s+)?see\s+(?:the\s+)?(?:complete\s+)?disclaimer\b/i.test(lower) ||
    /\bvisit\s+(?:our|the)\s+website\b/i.test(lower) ||
    /\bcheck\s+(?:out\s+)?(?:the\s+)?link\b/i.test(lower) ||
    /\blink\s+in\s+the\s+description\b/i.test(lower) ||
    /\bfor\s+more\s+(?:info|information)\b/i.test(lower) ||
    /\b(?:patreon|paypal|instagram|twitter|tiktok|facebook)\b/i.test(lower)
  ) {
    return true;
  }

  const stripped = lower.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (stripped.length === 0) return true;
  if (COMMON_HALLUCINATIONS.has(stripped)) return true;
  if (ISOLATED_SILENCE_FILLERS.has(stripped)) return true;

  // Definitive hallucination patterns that must never appear in candidate speech
  if (
    /\b(?:thank\s+you|thanks)\s+(?:very\s+much\s+)?for\s+watching\b/i.test(stripped) ||
    /\b(?:like\s+and\s+subscribe|please\s+subscribe|subscribe\s+to\s+(?:my|the|our)\s+channel)\b/i.test(stripped) ||
    /\bsee\s+you\s+(?:in\s+the\s+next\s+video|in\s+my\s+next\s+video)\b/i.test(stripped) ||
    /\bhope\s+you\s+enjoyed\s+this\s+video\b/i.test(stripped) ||
    /\bi'?m\s+steve\b/i.test(stripped) ||
    /\bcell\s+hyperlinks\b/i.test(stripped) ||
    /\badmin\s+desktop\b/i.test(stripped) ||
    /\brearm\s+menus\b/i.test(stripped) ||
    /\badministrative\s+packages\b/i.test(stripped) ||
    /^(?:etc|much|always|more|and\s+more|q\s*&?\s*a|q&a)[\s.,!]*$/i.test(stripped) ||
    /\b(?:subtitles?|transcript(?:ion)?|translated|captioned)\s+by\b/i.test(stripped) ||
    /\b(?:microsoft\s+office|word\.document|msworddoc|worddoc|word\.document\.8|office\s+word|rtf\s+document|powerpoint|excel|acrobat)\b/i.test(stripped) ||
    /\b(?:next\s+slide|previous\s+slide|slide\s+please|this\s+lecture|next\s+lecture|in\s+this\s+lecture|watch(?:ing)?\s+this\s+lecture|thank\s+you\s+for\s+watching\s+this\s+lecture)\b/i.test(stripped) ||
    /\b(?:cosplay|anime|manga|otaku|fandom|take\s+up\s+the\s+whole\s+floor|without\s+sanity|brain-dead\s+right\s+here|full\s+episode|check\s+the\s+description)\b/i.test(stripped) ||
    /\b(?:in\s+amish)\b/i.test(stripped) ||
    /\b([a-zA-Z]{3,}(?:\s+[a-zA-Z]{3,})?)\b(?:\s+\1\b){2,}/i.test(stripped)
  ) {
    return true;
  }

  const words = stripped.split(" ").filter(Boolean);

  // Distinguish true hallucinations (YouTube outros, subtitle credits, signoff loops)
  const STRONG_HALLUCINATION_WORDS = new Set([
    "watching",
    "subscribe",
    "subtitles",
    "captioned",
    "translated",
    "goodbye",
    "byebye",
    "bye",
    "recorded",
    "closing",
    "lord",
    "slide",
    "cosplay",
    "msworddoc",
  ]);

  // Check if every word in a short phrase (<= 6 words) is from the hallucination set AND contains a strong marker
  if (
    words.length <= 6 &&
    words.every((w) => HALLUCINATION_WORD_SET.has(w)) &&
    words.some((w) => STRONG_HALLUCINATION_WORDS.has(w))
  ) {
    return true;
  }

  // Any short combination (<= 4 words) made exclusively of greetings/closings/fillers without substantive answer
  // e.g. "Thank you. Bye. Bye.", "Bye bye", "Okay. Thank you.", "Thank you bye"
  if (
    words.length >= 2 &&
    words.length <= 4 &&
    words.every((w) => /^(?:thank|thanks|you|bye|goodbye|byebye|ok|okay|all|right|yep|yeah|so)$/i.test(w)) &&
    words.some((w) => /^(?:bye|goodbye|byebye)$/i.test(w))
  ) {
    return true;
  }

  // Repetitive tokens (e.g. "bye bye bye", "bye-bye.bye-bye.")
  if (words.length >= 2 && words.every((w) => w === words[0] || w === "bye")) {
    const allowedRepeatedWords = new Set(["hello", "hi", "yes", "no", "ok", "okay", "sure", "testing", "right"]);
    if (words.length === 2 && allowedRepeatedWords.has(words[0])) {
      return false;
    }
    return true;
  }

  // Repetition loop detector on trailing breath / noise bursts
  // e.g. "Okay. Thank you. Bye. Thank you. Bye bye. Bye. Oh, I'm sorry. Yeah. Thank you. Thanks. Thank you. Bye. Bye."
  if (words.length >= 4) {
    const unique = new Set(words);
    const lexicalDiversity = unique.size / words.length;
    if (words.length >= 6 && lexicalDiversity < 0.48) {
      return true;
    }
    const hallucinationTokens = words.filter((w) => HALLUCINATION_WORD_SET.has(w));
    if (hallucinationTokens.length / words.length >= 0.65 && lexicalDiversity < 0.6) {
      return true;
    }
  }

  // Common conversational hallucination patterns on tail breaths / noise bursts
  if (
    /^(?:and\s+)?(?:much\s+)?more[\s.,!]*$/i.test(stripped) ||
    /^(?:thank\s+you[\s.,!]*){2,}$/i.test(stripped) ||
    /^(?:thanks[\s.,!]*){2,}$/i.test(stripped) ||
    /^(?:okay[\s.,!]*){3,}$/i.test(stripped) ||
    /\b(?:signal\s+question|change\s+question\s+index|signal_question_change)\b/i.test(stripped) ||
    /^tor\b/i.test(stripped) ||
    /\bthank\s+you\s+(?:very\s+|all\s+)?(?:so\s+)?much\s+for\s+being\s+here\b/i.test(stripped) ||
    /\bsee\s+you\s+next\s+year\b/i.test(stripped) ||
    /^(?:alright|all\s+right|yep|yeah)[\s,.]+(?:peace|ok|okay)[\s,.]*$/i.test(stripped) ||
    /^(?:yep|yeah)[\s,.]+(?:ok|okay)[\s,.]*$/i.test(stripped) ||
    /^(?:ok|okay)[\s,.]+(?:yep|yeah)[\s,.]*$/i.test(stripped) ||
    /^(?:peace|yep|alright|see\s*ya|seeya)[\s,.]*$/i.test(stripped) ||
    /^(i\s*('?ll|will)|we\s*('?ll|will))\s+see\s+you\b/i.test(stripped) ||
    /^(so\s+)?(i\s*('?ll|will))\s+try\s+to\s+(complete|finish)\b/i.test(stripped) ||
    /^(i\s*('?ll|will))\s+be\s+(right\s+)?back\b/i.test(stripped) ||
    /^(anyone|anybody)\s+else\b/i.test(stripped) ||
    /\bchange\s+the\s+interview\b/i.test(stripped) ||
    /^(in\s+a\s+couple(\s+more)?\s+minutes)\b/i.test(stripped) ||
    /\bsee\s+you\s+(tomorrow|then|soon|later|next\s+time|in)\b/i.test(stripped) ||
    /\b(so\s+)?thank\s+the\s+lord\b/i.test(stripped) ||
    /\bkeep\s+it\s+closing\b/i.test(stripped) ||
    /\bbefore\s+is\s+material\b/i.test(stripped) ||
    /\b(and\s+)?that'?s\s+all\s+there\s+is\s+to\s+it\b/i.test(stripped) ||
    /\bthank\s+you\s+all\s+(so|very)\s+much\b/i.test(stripped) ||
    /\bopengithub\b/i.test(stripped) ||
    /\brahul\s+adme\b/i.test(stripped) ||
    /\bthe\s+interview\s+is\s+now\s+over\b/i.test(stripped) ||
    /\bthe\s+assessment\s+will\s+be\s+performed\b/i.test(stripped) ||
    /\b(not\s+see|will\s+not\s+see)\s+this\s+product\b/i.test(stripped) ||
    /\bit'?s\s+a\s+little\s+hot\s+in\s+there\b/i.test(stripped) ||
    /\bthis\s+is\s+not\s+going\s+to\s+be\s+happening\b/i.test(stripped) ||
    /\bbecause\s+you\s+have\s+to\s+do\s+it\s+somehow\s+in\s+order\s+to\s+use\s+it\b/i.test(stripped)
  ) {
    return true;
  }

  // Non-English script hallucination when interview language is English
  if (lang.toLowerCase().startsWith("en")) {
    // Devanagari (Hindi \u0900-\u097F), Cyrillic (\u0400-\u04FF), Arabic (\u0600-\u06FF), CJK (\u4E00-\u9FFF), Korean Hangul (\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F)
    if (/[\u0900-\u097F\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(trimmed)) {
      return true;
    }
    // Non-English Latin diacritics that do not appear in standard English words
    if (/[ățșîâ]/i.test(trimmed)) {
      return true;
    }
    // Subtitle credits
    if (/^(subtitles? by|transcript(ion)? by|translated by|captioned by)/i.test(stripped)) {
      return true;
    }
  }

  return false;
}
