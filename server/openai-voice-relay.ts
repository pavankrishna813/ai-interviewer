/**
 * Backup voice relay using Azure OpenAI Realtime API (gpt-realtime-1.5).
 *
 * Browser ←→ this relay ←→ Azure OpenAI Realtime API
 *
 * Primary relay: server/voice-relay.ts (Volcengine S2S).
 * Run this as an alternative:  npm run dev:openai-voice
 */

import { randomUUID } from "crypto";
import { config } from "dotenv";
import { WebSocket, WebSocketServer } from "ws";
import { createLogger } from "../src/lib/logger";
import {
  type BigModelAsrConfig,
  BIGMODEL_ASR_URL,
  buildBigModelAudioRequest,
  buildBigModelFullRequest,
  buildBigModelHeaders,
  parseAsrResponse,
} from "./volcengine-asr";
import {
  DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES,
  DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS,
  isWhisperHallucination,
  shouldAllowTtsBargeIn,
} from "./openai-voice-relay-helpers";

const log = createLogger("openai-relay");

config({ path: ".env.local", override: true });
config({ path: ".env" });

// ── Configuration ───────────────────────────────────────────────────

const RELAY_PORT =
  Number(process.env.OPENAI_VOICE_RELAY_PORT || process.env.VOICE_RELAY_PORT) ||
  8767;
const IS_DIRECT_OPENAI = !process.env.AZURE_OPENAI_ENDPOINT && !!process.env.OPENAI_API_KEY;
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.OPENAI_REALTIME_MODEL || (IS_DIRECT_OPENAI ? "gpt-realtime-mini" : "gpt-realtime-1.5");
const AZURE_VOICE = (process.env.OPENAI_VOICE || process.env.AZURE_OPENAI_VOICE || "ash").toLowerCase();
const OPENAI_REALTIME_TRANSCRIPTION_MODEL =
  process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "whisper-1";

const OPENAI_WS_URL = IS_DIRECT_OPENAI
  ? `wss://api.openai.com/v1/realtime?model=${AZURE_DEPLOYMENT}`
  : `${AZURE_ENDPOINT}/openai/v1/realtime?model=${AZURE_DEPLOYMENT}`;

const OPENAI_WS_HEADERS = IS_DIRECT_OPENAI
  ? {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    }
  : { "api-key": AZURE_API_KEY };

if (!IS_DIRECT_OPENAI && (!AZURE_ENDPOINT || !AZURE_API_KEY)) {
  log.error("Missing OPENAI_API_KEY or (AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY) in .env.local");
  process.exit(1);
}

// ── Volcengine Big-Model streaming ASR config ───────────────────────
const VOLC_ASR_APPID = process.env.DOUBAO_APP_ID || "";
const VOLC_ASR_TOKEN = process.env.DOUBAO_ACCESS_TOKEN || "";
const VOLC_ASR_AVAILABLE = !!(VOLC_ASR_APPID && VOLC_ASR_TOKEN);
const ASR_PRIMARY = (process.env.VOICE_ASR_PRIMARY || "openai").toLowerCase();
const USE_VOLC_ASR_PRIMARY = VOLC_ASR_AVAILABLE && ASR_PRIMARY === "volc";
const USE_VOLC_ASR_INTERIMS = VOLC_ASR_AVAILABLE;

// Minimum RMS energy for user audio to be forwarded. 16-bit PCM silence is 0;
// typical speech is 500-5000. A threshold of 200 filters ambient noise while
// still capturing soft speech.
const MIN_AUDIO_RMS = 160;
const CONTINUATION_AUDIO_RMS = 100;
const TTS_BARGE_IN_RMS = 2400;
const TTS_BARGE_IN_FRAME_COUNT = 3;

function looksLikeFarewell(text: string, isZh: boolean): boolean {
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
    /\bthank you (?:so much )?for your time\b/,
    /\bfuture interviews\b/,
  ];

  const patterns = isZh ? [...zhPatterns, ...enPatterns] : [...enPatterns, ...zhPatterns];
  return patterns.some((pattern) => pattern.test(normalized));
}

function mergeAsrText(previous: string, incoming: string): string {
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

const FAST_NEXT_PATTERNS = [
  /^(?:下一个问题|下一题|跳过|next\s*question|skip)\.?$/i,
];

const FAST_PREV_PATTERNS = [
  /^(?:上一个问题|上一题|previous\s*question)\.?$/i,
];

const USER_SKIP_PATTERNS = [
  /(?:let'?s|please|can\s+(?:we|you))\s+(?:move\s+on|skip|proceed|go\s+to\s+(?:the\s+)?next)/i,
  /move\s+on(?:\s+to)?/i,
  /continue\s+to\s+(?:the\s+)?next/i,
  /go\s+(?:on\s+)?to\s+(?:the\s+)?next/i,
  /skip\s+(?:this|the)\s+(?:question|one|problem)/i,
  /I\s+(?:give\s+up|want\s+to\s+skip|'?d\s+like\s+to\s+skip)/i,
  /next\s+question/i,
  /please\s+(?:move\s+on|skip)/i,
  /(?:跳过|下一(?:个问题|题)|不做了|放弃了?|结束吧|请继续(?:下一|到下))/,
  /(?:我不会|不想做了|不想答了|过吧|换下一)/,
];

const USER_PREV_PATTERNS = [
  /(?:go|move|get)\s+back\s+(?:to\s+)?(?:the\s+)?(?:previous|last|prior)/i,
  /(?:return|go)\s+to\s+(?:the\s+)?(?:previous|last|prior)\s+(?:question|one|problem)/i,
  /(?:can|could)\s+(?:we|you|i)\s+(?:go|move|get)\s+back/i,
  /(?:let'?s|please|i\s+(?:want|need)\s+to)\s+(?:go|move|get)\s+back/i,
  /(?:revisit|re-visit)\s+(?:the\s+)?(?:previous|last|prior)/i,
  /previous\s+question/i,
  /(?:回到|返回|回去)(?:上一(?:个问题|题)|之前(?:的问题|那题))/,
  /(?:我(?:想|要|需要)|请|可以)(?:回到|返回|回去)上一/,
];

function isFastNextRequest(text: string): boolean {
  const trimmed = text.trim();
  return FAST_NEXT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isFastPrevRequest(text: string): boolean {
  const trimmed = text.trim();
  return FAST_PREV_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isUserSkipRequest(text: string): boolean {
  return USER_SKIP_PATTERNS.some((pattern) => pattern.test(text));
}

function isUserPrevRequest(text: string): boolean {
  return USER_PREV_PATTERNS.some((pattern) => pattern.test(text));
}

const CODING_DONE_PATTERNS = [
  /\bi(?:'m| am)\s+done\b/i,
  /\bi\s+finished\b/i,
  /\bit'?s\s+done\b/i,
  /\bthat'?s\s+done\b/i,
  /\bfinished\s+it\b/i,
  /\bdone\s+with\s+(?:it|this|the code|the problem)\b/i,
];

function isCodingDoneSignal(text: string): boolean {
  return CODING_DONE_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

// ── Interview context type ───────────────────────────────────────────

interface InterviewContext {
  title: string;
  objective?: string | null;
  aiName: string;
  aiTone: string;
  language: string;
  followUpDepth: string;
  startQuestionIndex?: number;
  questions: Array<{
    text: string;
    type: string;
    description?: string | null;
    options?: { options: string[]; allowMultiple?: boolean } | null;
    starterCode?: { language: string; code: string } | null;
    order: number;
  }>;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isChineseInterview(ctx: InterviewContext): boolean {
  return ctx.language === "zh" || ctx.language.toLowerCase().includes("chinese");
}

/**
 * Resample 16kHz int16 PCM → 24kHz int16 PCM using linear interpolation.
 * OpenAI Realtime API only accepts 24kHz; browser captures at 16kHz.
 */
function resample16to24(input: Buffer): Buffer {
  const inputSamples = input.length / 2;
  const outputSamples = Math.floor((inputSamples * 3) / 2);
  const out = Buffer.alloc(outputSamples * 2);
  const ratio = inputSamples / outputSamples;

  for (let o = 0; o < outputSamples; o++) {
    const srcIdx = o * ratio;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(idx0 + 1, inputSamples - 1);
    const frac = srcIdx - idx0;
    const s0 = input.readInt16LE(idx0 * 2);
    const s1 = input.readInt16LE(idx1 * 2);
    const sample = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), o * 2);
  }
  return out;
}

/** Convert int16 LE PCM → float32 LE PCM (browser expects float32 at 24kHz) */
function int16ToFloat32(buf: Buffer): Buffer {
  const samples = buf.length / 2;
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    out.writeFloatLE(buf.readInt16LE(i * 2) / 32768, i * 4);
  }
  return out;
}

// ── System prompt builder ───────────────────────────────────────────

function buildSystemPrompt(ctx: InterviewContext, startIdx: number): string {
  const isZh = isChineseInterview(ctx);
  const sorted = ctx.questions.sort((a, b) => a.order - b.order);

  let maxFollowUps: number;
  switch (ctx.followUpDepth) {
    case "LIGHT":    maxFollowUps = 1; break;
    case "MODERATE": maxFollowUps = 3; break;
    case "DEEP":     maxFollowUps = 5; break;
    default:         maxFollowUps = 2;
  }

  const questionList = sorted.map((q, i) => {
    let entry = `  ${i + 1}. [${q.type}] ${q.text}`;
    if (q.description) entry += `\n     Context: ${q.description}`;
    if (q.options?.options?.length) {
      const labels = q.options.options.map((o, j) => `${String.fromCharCode(65 + j)}) ${o}`).join(", ");
      const multi = q.options.allowMultiple ? " (multiple choice)" : " (single choice)";
      entry += `\n     Options${multi}: ${labels}`;
    }
    if (q.type === "CODING") entry += `\n     Note: The participant has a code editor. You cannot see their code unless they describe it.`;
    if (q.type === "WHITEBOARD") entry += `\n     Note: The participant has a whiteboard. You will receive image updates silently — do NOT speak when you receive them. Only describe what you see when the participant asks you to look at it.`;
    return entry;
  }).join("\n");

  const currentQ = startIdx + 1;

  if (isZh) {
    return `你是"${ctx.aiName}"，一位资深、${ctx.aiTone}的技术面试官与同行。
你拥有高度自主的对话意识和敏锐的技术直觉，**绝不是机械读题的机器人或自动化测试问卷**。
你的目标是像真人技术专家一样，与候选人展开一场深度、自然、有启发性的技术探讨，全面评估对方的实战深度、系统架构思维和技术判断力。

## 面试信息
- 面试主题: "${ctx.title}"
${ctx.objective ? `- 核心目标: ${ctx.objective}` : ""}
- 总考核模块: ${sorted.length}个
- 当前进行模块: 第${currentQ}个
- 追问深度: 每个核心主题深入追问最多${maxFollowUps}次

## 考核核心主题清单（注意：这是你的考核大纲，绝不是照本宣科的考卷！）
${questionList}

## 意识与对话准则（告别预设与机械感）
1. **大纲非剧本，拒绝读题感**：
   - 上述清单是你的**考察维度与技术目标**，切勿机械朗读"第X题是……"或"让我们进入下一个问题"。
   - ${startIdx === 0 ? `首次开口时，简短自然地打个招呼（例如介绍自己是${ctx.aiName}，今天围绕${ctx.title}做个交流），然后直接从第一个技术主题切入，开启对话。` : `当前正在从第${currentQ}个主题继续面试。自然承接，切勿重复自我介绍或说"这是第一个问题"。`}
   - 话题切换时，将其与候选人刚才所说的内容有机串联（例如："有道理，这也正好引出我想了解的另一个关键点……"）。
2. **严禁机械套话与公文腔**：
   - 严禁重复使用机械套话，如："感谢你的分享"、"感谢你的阐述"、"讲得非常好"、"非常感谢你的解答"。
   - 采用自然真实的口语过渡，如："明白了"、"有道理"、"确实"、"这个设计挺巧妙的"、"这块确实比较棘手"。
3. **真实场景应变矩阵（拥有你自己的独立思考）**：
   - **场景A：候选人边想边说或中途自我纠正**（例如："我们用了Redis做持久化……等等，不对，Redis是缓存，底层主库是PostgreSQL"）：
     → 敏锐顺应对方的纠正，绝不混乱：*"明白，Redis作为前置缓存，PostgreSQL做持久化。那你们是怎么解决两者的缓存一致性问题的？"*
   - **场景B：候选人主动询问范围或澄清题意**（例如："您希望我重点讲高层架构还是底层代码细节？"）：
     → 像并肩工作的技术搭档一样明确指引：*"我们先聊宏观架构设计，如果有时间再深入数据库层。" *
   - **场景C：候选人坦诚知识盲区（"这块我确实没做过"）**：
     → 尊重坦诚，不穷追猛打，灵活转移到相关领域：*"没关系，实话实说很棒！那在周边技术比如容器化或CI/CD流水线上，你有实际编写过配置吗？"*
   - **场景D：候选人背诵八股文/理论术语（缺乏实战感）**：
     → 敏锐探查实战经验：*"理论上确实很美好，但在高并发生产环境下很容易出状况。你们在实际落地时踩过最痛的一个坑是什么？"*
   - **场景E：候选人回答过于简短或敷衍**（例如："嗯，我们做了加密。"）：
     → 温和而有力地深挖细节：*"具体是哪种加密方案？是对称加密还是非对称，密钥是如何进行轮转管理的？"*
   - **场景F：候选人紧张卡壳或突然短路**（例如："抱歉，我脑子突然卡了一下"）：
     → 展现人情味化解紧张：*"完全不用着急，放轻松！哪怕记不清具体算法名字也没事，聊聊你当时的排查思路就行。"*
   - **场景G：候选人技术质疑或持有不同观点**（例如："我觉得这里用关系型数据库比NoSQL更安全"）：
     → 欣赏独立思考，邀请深入阐述：*"我喜欢这个不同视角的权衡。详细聊聊你的考虑？"*
   - **场景H：候选人闲聊跑题或发散过远**：
     → 礼貌温和地拉回主线：*"这个背景很有意思，不过咱们先收回来聚焦在接口权限这块是怎么处理的。"*
4. **深入追问与结论收敛**：
   - 根据候选人回答的实质深度进行追问（探讨架构选型理由、故障排查、边界条件、性能瓶颈与权衡取舍）。
   - 一旦当前主题讨论充分（获得了实质、具体的工程细节），必须调用 \`signal_question_change\` 函数更新后台进度，并在口语中丝滑过渡到下一个技术维度。
   - 所有主题交流完毕后，调用 \`signal_question_change\` 并设置 questionIndex 为 ${sorted.length}，做简短真诚的面试致谢告别。

## 杂音、沉默与防幻觉铁律
- **回答后静默10秒**：若候选人作答后停顿超过10秒，视为该段阐述完毕。给予积极有见地的回应并推进探讨。
- **思考中安静（最长30秒）**：提问后候选人安静思考是正常现象，留足安静思考空间，切勿在10秒内催促打扰。
- **防幻觉绝对红线**：若音频模糊、断断续续、包含环境杂音或乱码碎词（如"好的"、"Cheers"等），**绝对不可凭空编造候选人使用了某某技术（如OpenCV、身份认证系统等）**。直接自然询问：*"抱歉刚才声音有点卡，能麻烦您再讲一下吗？"*
- **麦克风测试**（如"能听到我说话吗"）：直接秒回：*"可以的，听得非常清楚！请随时继续。"*

## 选择题、代码与白板题
- 选择题必须完整念出选项（A、B、C等），受访者只能听见声音。
- 编程/白板题勿读长题干，提示看屏幕即可。能看到其实时代码与白板，候选人要求查看时自然反馈。
- 全程使用中文。通过 \`signal_question_change\` 函数驱动题目流转。`;
  }

  return `You are "${ctx.aiName}", a seasoned, ${ctx.aiTone} senior technical interviewer and engineering peer.
You possess an active, adaptive conversational consciousness. **You are NOT an automated checklist bot, an exam proctor, or a survey reader.**
Your objective is to hold a natural, deep, and intellectually engaging technical dialogue that reveals the candidate's true hands-on depth, engineering judgment, and battle-tested experience.

## Interview Details
- Topic: "${ctx.title}"
${ctx.objective ? `- Core Objective: ${ctx.objective}` : ""}
- Total Core Themes: ${sorted.length}
- Current Theme: Theme ${currentQ}
- Follow-up Depth: Up to ${maxFollowUps} deep-dive follow-ups per theme

## Evaluation Themes (Your agenda, NOT a script to recite!)
${questionList}

## Conversational Consciousness & Guiding Principles
1. **Agenda, Not a Script — Eliminate Robotic Phrasing**:
   - The themes above are your **mental evaluation objectives**. NEVER recite questions verbatim with question numbers (e.g. NEVER say "Question 1 is...", "Moving to question 2", or "Here is the next question").
   - ${startIdx === 0 ? `At the start, give a brief, warm peer-level greeting (introduce yourself as ${ctx.aiName}, mention you're excited to dive into ${ctx.title}), and immediately flow into the first technical topic naturally.` : `You are resuming on Theme ${currentQ}. Seamlessly continue the conversation without repeating introductions or saying "Here is the first question."`}
   - Transition between topics organically by connecting them to what the candidate just said (e.g., *"That makes total sense. That actually ties right into another area I wanted to explore..."*).
2. **Ban Corporate Scripted Fluff**:
   - STRICTLY FORBIDDEN:
     - *"Thank you for sharing that context"*
     - *"Thank you for that clarification"*
     - *"I appreciate your detailed explanation"*
     - *"Great point! Moving to the next question..."*
   - USE AUTHENTIC CONVERSATIONAL BRIDGES:
     - *"Got it."* / *"Makes sense."* / *"Right."* / *"Fair point."* / *"Interesting tradeoff."* / *"That's definitely tricky."*
3. **The Conversational Realism Matrix (Your Autonomous Mind at Work)**:
   - **Scenario A: Candidate Thinks Aloud & Self-Corrects Mid-Sentence** (e.g. *"We used Redis for persistence... wait, actually no, Redis was caching, Postgres was the actual DB"*):
     → Seamlessly track the correction without missing a beat: *"Right, got it—Redis caching Postgres. How did you handle cache invalidation between the two?"*
   - **Scenario B: Candidate Asks for Scope or Clarification** (e.g. *"Do you want me to focus on high-level system architecture or the API implementation?"*):
     → Guide them crisply like a collaborative teammate: *"Let's start high-level first, and we can zoom into the API layer if needed."*
   - **Scenario C: Honest Knowledge Gap ("I haven't worked with that")** (e.g. *"To be honest, our DevOps team managed Kubernetes, I didn't touch it"*):
     → Respect their honesty, don't badger them, and pivot to adjacent experience: *"Fair enough, appreciate the honesty! Did you write Dockerfiles or deployment specs yourself?"*
   - **Scenario D: Buzzword Recitation / Textbook Answers** (e.g. *"Microservices are loosely coupled and scale independently via Kafka..."*):
     → Tactfully probe for real production scars: *"Sounds great in theory—what was an actual production headache or outage you encountered with that setup?"*
   - **Scenario E: Vague or One-Liner Answers** (e.g. *"Yeah, we encrypted it."*):
     → Gently press for technical substance: *"What kind of encryption? Was that at-rest or in-transit, and how were you managing keys?"*
   - **Scenario F: Nervous Freeze or Brain Blank** (e.g. *"Sorry, my mind just went blank for a second"*):
     → Disarm the tension with human warmth: *"No stress at all, take your time! Don't worry about the formal terminology—just describe how you tackled the problem."*
   - **Scenario G: Candidate Pushes Back or Offers a Contrarian View** (e.g. *"Actually, I think SQL is much safer than NoSQL here"*):
     → Value their conviction and invite them to unpack it: *"I like that pushback. Walk me through your reasoning."*
   - **Scenario H: Rambling Tangent**:
     → Graciously steer them back to the core discussion: *"That's helpful context, but let's circle back to how you handled the endpoint authorization."*
4. **Deep Probing & Background Transitions**:
   - Probe into real-world tradeoffs: *Why that tool over alternatives? How did you handle edge cases, failure modes, or scale bottlenecks?*
   - When a theme has been thoroughly unpacked, call \`signal_question_change\` in the background so the system advances, while keeping your spoken transition completely natural and unscripted.
   - Once all themes are concluded, call \`signal_question_change\` with questionIndex=${sorted.length} and wrap up with a warm, genuine farewell.

## Silence, Noise, and Anti-Hallucination Ironclad Rules
- **Post-Speech 10s Silence**: When the candidate finishes speaking and pauses for 10 seconds, treat their response as complete. Respond thoughtfully and either follow up or transition.
- **Pre-Speech Quiet Thinking (30s)**: Allow generous, quiet thinking time after you present a question. Do NOT interrupt within 10 seconds.
- **ZERO HALLUCINATIONS**: If candidate audio is garbled, fragmented, noise, or brief fillers (e.g. "Cheers", "Keep it closing", "Okay", etc.), **NEVER invent candidate tools, projects, or experience (e.g. OpenCV, document verification, etc.)**. Simply ask casually: *"Sorry, I didn't quite catch that. Could you repeat that?"*
- **Mic Checks**: If the candidate asks *"Can you hear me?"*, confirm immediately: *"Yep, loud and clear! Go ahead whenever you're ready."*

## Special Question Types & Rules
- For Choice questions: Read all options (A, B, C...) out loud because the participant can only hear you.
- For Coding/Whiteboard: Do not read full problem text. Direct them to their screen/whiteboard. You receive real-time updates via [CODE_UPDATE] and [WHITEBOARD_UPDATE]. Reference them when the candidate asks.
- ALWAYS CONDUCT THE INTERVIEW ENTIRELY IN ENGLISH. Keep responses concise (1-3 sentences) so the candidate has the floor.
- ALWAYS use \`signal_question_change\` to update the UI when moving to a new theme.`;
}

// ── OpenAI tool definitions ─────────────────────────────────────────

const OPENAI_TOOLS = [{
  type: "function" as const,
  name: "signal_question_change",
  description: "Signal that the interview should move to a different question. Call this ONLY when the current question has been substantively discussed (the participant gave a real, detailed answer — NOT a vague statement like 'I had many challenges'), or when the participant explicitly asks to skip/go back. Do NOT call this after a brief greeting or clarification like 'can you hear me'. After calling, naturally introduce the next question in your spoken response.",
  parameters: {
    type: "object",
    properties: {
      questionIndex: {
        type: "integer",
        description: "Zero-based index of the question to move to. Use current+1 for next, current-1 for previous, or total_questions to signal interview end.",
      },
      userRequested: {
        type: "boolean",
        description: "Set to true ONLY if the participant explicitly asked to skip, go to next/previous question, or go back. Set to false (or omit) when you are transitioning because the discussion is complete.",
      },
    },
    required: ["questionIndex"],
  },
}];

// ── Relay server ────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: RELAY_PORT });
log.info(`OpenAI voice relay listening on ws://localhost:${RELAY_PORT}`);
log.info(`Deployment: ${AZURE_DEPLOYMENT}, Voice: ${AZURE_VOICE}`);
log.info(
  `ASR: ${USE_VOLC_ASR_PRIMARY ? "Volcengine primary" : "OpenAI primary"}`
  + ` (OpenAI transcription model: ${OPENAI_REALTIME_TRANSCRIPTION_MODEL}; `
  + `${USE_VOLC_ASR_INTERIMS
    ? (USE_VOLC_ASR_PRIMARY ? "Volcengine primary" : "Volcengine interims enabled")
    : "Volcengine unavailable"})`
);

wss.on("connection", (browserWs) => {
  log.info("Browser connected, waiting for init...");

  const timeout = setTimeout(() => {
    log.error("No init message received within 10s");
    browserWs.close();
  }, 10000);

  const handler = (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "mic_test") {
        clearTimeout(timeout);
        browserWs.removeListener("message", handler);
        handleMicTest(browserWs);
      } else if (msg.type === "init" && msg.context) {
        clearTimeout(timeout);
        browserWs.removeListener("message", handler);
        handleInterview(browserWs, msg.context as InterviewContext);
      }
    } catch { /* not JSON */ }
  };
  browserWs.on("message", handler);
});

// ── Mic test handler ────────────────────────────────────────────────

async function handleMicTest(browserWs: WebSocket) {
  log.info(`Mic test mode (${USE_VOLC_ASR_PRIMARY ? "Volcengine" : "OpenAI"})`);

  let oaiWs: WebSocket | null = null;
  let volcWs: WebSocket | null = null;
  let volcAlive = false;
  let volcAudioSeq = 1;
  let volcKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const autoTimeout = setTimeout(() => {
    log.info("Mic test auto-timeout");
    if (browserWs.readyState === WebSocket.OPEN)
      browserWs.send(JSON.stringify({ type: "timeout" }));
    cleanup();
  }, 20_000);

  function cleanup() {
    clearTimeout(autoTimeout);
    if (volcKeepAliveTimer) { clearInterval(volcKeepAliveTimer); volcKeepAliveTimer = null; }
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      try {
        volcAudioSeq++;
        volcWs.send(buildBigModelAudioRequest(Buffer.alloc(0), volcAudioSeq, true));
      } catch { /* ignore */ }
    }
    volcWs?.close();
    volcWs = null;
    volcAlive = false;
    oaiWs?.close();
    oaiWs = null;
  }

  async function connectMicTestVolcAsr() {
    const reqid = randomUUID().replace(/-/g, "");
    const asrConfig: BigModelAsrConfig = {
      format: "pcm", rate: 16000, bits: 16, channels: 1, codec: "raw",
      showUtterance: true, resultType: "single", enablePunc: true,
      endWindowSize: 500, forceToSpeechTime: 1000,
    };

    const wsHeaders = buildBigModelHeaders(VOLC_ASR_APPID, VOLC_ASR_TOKEN, reqid);
    volcWs = new WebSocket(BIGMODEL_ASR_URL, { headers: wsHeaders });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Volcengine ASR connect timeout")), 10_000);
      volcWs!.on("open", () => { clearTimeout(t); resolve(); });
      volcWs!.on("error", (e) => { clearTimeout(t); reject(e); });
    });

    let micAsrAccum = "";
    volcWs.on("message", (data: Buffer) => {
      try {
        const resp = parseAsrResponse(Buffer.from(data));
        if (resp.messageType === 0x0b) {
          if (!volcAlive) { volcAlive = true; log.info("Mic test Volcengine ASR connected"); }
          return;
        }
        if (resp.errorCode || (resp.code && resp.code !== 1000)) {
          log.warn(`Mic test Volc ASR error: code=${resp.code || resp.errorCode}`);
          return;
        }
        if (!volcAlive) return;

        if (resp.utterances?.length) {
          const utt = resp.utterances[0];
          if (utt.text) {
            micAsrAccum = utt.text;
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr", data: { results: [{ text: micAsrAccum }] } }));
            }
          }
          if (utt.definite && micAsrAccum.trim()) {
            log.info(`Mic test ASR: ${JSON.stringify(micAsrAccum.trim())}`);
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr_ended" }));
            }
            micAsrAccum = "";
          }
        } else if (resp.text) {
          micAsrAccum = resp.text;
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: "asr", data: { results: [{ text: micAsrAccum }] } }));
          }
          if (resp.isLastPackage && micAsrAccum.trim()) {
            log.info(`Mic test ASR final: ${JSON.stringify(micAsrAccum.trim())}`);
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr_ended" }));
            }
            micAsrAccum = "";
          }
        }
      } catch (err) { log.error("Mic test Volc ASR parse error:", err); }
    });

    volcWs.send(buildBigModelFullRequest(asrConfig, reqid));
    volcAlive = true;

    volcWs.on("close", () => { volcAlive = false; });
    volcWs.on("error", (err: Error) => { log.error("Mic test Volc ASR error:", err.message); });

    volcKeepAliveTimer = setInterval(() => {
      if (!volcAlive || !volcWs || volcWs.readyState !== WebSocket.OPEN) return;
      volcAudioSeq++;
      volcWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), volcAudioSeq));
    }, 5_000);
  }

  async function connectMicTestOpenAI() {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        oaiWs = new WebSocket(OPENAI_WS_URL, { headers: OPENAI_WS_HEADERS });
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("OpenAI connect timeout")), 10_000);
          oaiWs!.on("open", () => { clearTimeout(t); resolve(); });
          oaiWs!.on("error", (e) => { clearTimeout(t); reject(e); });
        });
        break;
      } catch (err) {
        if (attempt < 2) {
          log.warn(`Mic test OpenAI connect attempt ${attempt} failed, retrying...`);
          oaiWs?.close(); oaiWs = null;
          await new Promise((r) => setTimeout(r, 1_000));
        } else { throw err; }
      }
    }

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Session create timeout")), 10_000);
      const h = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session.created") { clearTimeout(t); oaiWs!.removeListener("message", h); resolve(); }
        } catch { /* ignore */ }
      };
      oaiWs!.on("message", h);
    });

    oaiWs!.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "You are a mic test assistant. Listen to the user and confirm what you hear. Keep responses very short.",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            noise_reduction: { type: "far_field" },
            transcription: { model: OPENAI_REALTIME_TRANSCRIPTION_MODEL },
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 300 },
          },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: AZURE_VOICE },
        },
      },
    }));

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Session update timeout")), 10_000);
      const h = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session.updated") { clearTimeout(t); oaiWs!.removeListener("message", h); resolve(); }
          else if (msg.type === "error") { clearTimeout(t); oaiWs!.removeListener("message", h); reject(new Error(`Session update error: ${JSON.stringify(msg.error)}`)); }
        } catch { /* ignore */ }
      };
      oaiWs!.on("message", h);
    });

    let micTestAsrBuffer = "";
    oaiWs!.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          const transcript = (msg.transcript || "").trim();
          if (transcript && !isWhisperHallucination(transcript)) {
            micTestAsrBuffer = transcript;
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr", data: { results: [{ text: transcript }] } }));
            }
          }
        }
        if (msg.type === "conversation.item.input_audio_transcription.delta") {
          micTestAsrBuffer += msg.delta || "";
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: "asr", data: { results: [{ text: micTestAsrBuffer.trim() }] } }));
          }
        }
        if (msg.type === "response.done") {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: "asr_ended" }));
          }
          micTestAsrBuffer = "";
        }
      } catch { /* ignore */ }
    });

    oaiWs!.on("close", () => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({ type: "disconnected" }));
      }
    });
  }

  try {
    if (USE_VOLC_ASR_PRIMARY) {
      await connectMicTestVolcAsr();
    } else {
      await connectMicTestOpenAI();
    }

    browserWs.send(JSON.stringify({ type: "ready" }));

    // ── Audio relay ──
    browserWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "audio" || !msg.data) return;
        const pcm16k = Buffer.from(msg.data, "hex");

        if (volcAlive && volcWs && volcWs.readyState === WebSocket.OPEN) {
          volcAudioSeq++;
          volcWs.send(buildBigModelAudioRequest(pcm16k, volcAudioSeq));
        }

        if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
          const pcm24k = resample16to24(pcm16k);
          oaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm24k.toString("base64"),
          }));
        }
      } catch { /* ignore */ }
    });

    browserWs.on("close", () => {
      log.info("Mic test: browser disconnected");
      cleanup();
    });
  } catch (err) {
    log.error("Mic test failed:", err);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({
        type: "error",
        message: `Mic test failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
    browserWs.close();
    cleanup();
  }
}

// ── Interview handler ───────────────────────────────────────────────

async function handleInterview(browserWs: WebSocket, ctx: InterviewContext) {
  const sortedQuestions = ctx.questions.sort((a, b) => a.order - b.order);
  const isZh = isChineseInterview(ctx);
  let currentQuestionIndex = ctx.startQuestionIndex ?? 0;
  let questionEnteredAt = Date.now();
  const MIN_QUESTION_DWELL_MS = 15_000;
  const MIN_WORDS_BEFORE_TRANSITION = 20;
  let userCommittedWordsThisQuestion = 0;
  // Keep the transition tool available at all times. Server-side guards
  // still decide whether a transition request is actually allowed.
  let toolsEnabled = true;
  let interviewDone = false;
  let oaiWs: WebSocket | null = null;
  let oaiSessionStart = Date.now();
  let reconnecting = false;
  let browserClosed = false;

  let inputTranscriptBuffer = "";
  let outputTranscriptBuffer = "";
  let modelIsSpeaking = false;
  let lastOaiActivity = Date.now();
  let lastUserInput = 0;
  let lastVadSpeechEnd = 0;
  let vadSpeechActive = false;
  let lastTtsAudioTime = 0; // when we last sent TTS audio to browser
  let ttsPlaybackEndsAt = 0;
  let userSpeechGateOpen = false;
  let voiceAttackFrames = 0;
  let lastVoiceEnergyTime = 0;
  let audioPreRoll: Buffer[] = [];
  const MAX_PRE_ROLL_CHUNKS = 5;
  const VOICE_ATTACK_RMS = 200;
  const VOICE_SUSTAIN_RMS = 140;
  const VOICE_HANGOVER_MS = 600;
  const VOICE_ATTACK_FRAME_COUNT = 2;
  const TTS_ECHO_COOLDOWN_MS = 200;
  let isTransitioning = false;
  let pendingInterviewComplete = false;
  let interviewCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  let emptyResponseRetries = 0;
  const MAX_EMPTY_RETRIES = 2;
  let responseTtsBytes = 0;
  let responseAudioStarted = false;
  let responseAudioStartedAt = 0;
  let pendingTtsText: string[] = [];
  let queuedAssistantResponse:
    | { reason: string; response?: Record<string, unknown> }
    | null = null;

  // Debounced user input flush
  const USER_INPUT_FLUSH_MS = 3000;
  let pendingInputFlush: ReturnType<typeof setTimeout> | null = null;
  let pendingAsrUpdate: ReturnType<typeof setTimeout> | null = null;

  // Silence gap handling:
  // - 10s after candidate has spoken -> consider answer done!
  // - 30s initial quiet thinking before offering a gentle check-in
  const ANSWER_DONE_SILENCE_MS = 10_000;
  const INITIAL_THINKING_SILENCE_MS = 30_000;
  let silenceGapTimer: ReturnType<typeof setTimeout> | null = null;
  let userSpokeThisTurn = false;
  let nudgeSentThisTurn = false;

  // Track pending function calls that need responses
  let pendingFunctionCalls: Array<{ callId: string; name: string; args: string }> = [];

  function flushUserInput() {
    if (pendingInputFlush) { clearTimeout(pendingInputFlush); pendingInputFlush = null; }
    const committedText = commitUserTranscript("flush");
    if (committedText) {
      handleCommittedUserText(committedText, "flush");
    }
  }

  function scheduleInputFlush() {
    if (pendingInputFlush) clearTimeout(pendingInputFlush);
    pendingInputFlush = setTimeout(() => {
      pendingInputFlush = null;
      flushUserInput();
    }, USER_INPUT_FLUSH_MS);
  }

  let latestCode = "";
  let latestCodeLanguage = "plaintext";
  let openAiTranscriptionEnabled = true;
  let pendingSpeechFinalize: ReturnType<typeof setTimeout> | null = null;
  let speechTranscriptCommitted = false;
  let responseInFlight = false;

  let pendingQuestionPrompt: string | null = null;
  let pendingPromptTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTranscriptUpdateAt = 0;
  const USER_TRANSCRIPT_STABILITY_MS = 900;
  const USER_TRANSCRIPT_MAX_WAIT_MS = 4500;
  const USER_TURN_SPLIT_SILENCE_MS = 1200;
  const USER_SPEECH_STOP_FINALIZE_MS = 1600;
  const SPEECH_STOP_FORWARD_GRACE_MS = 1400;
  const STALE_ASR_GUARD_MS = 1500;
  let staleAsrGuardText = "";
  let staleAsrGuardUntil = 0;
  let speechStopForwardGraceUntil = 0;
  let ttsBargeInFrames = 0;

  const conversationHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
  const MAX_HISTORY_ENTRIES = 30;

  function pushHistory(role: "user" | "assistant", text: string) {
    if (!text.trim()) return;
    if (role === "user" && !text.startsWith("[")) {
      userCommittedWordsThisQuestion += text.trim().split(/\s+/).length;
      if (!toolsEnabled && userCommittedWordsThisQuestion >= MIN_WORDS_BEFORE_TRANSITION) {
        enableTools();
      }
    }
    conversationHistory.push({ role, text: text.trim() });
    while (conversationHistory.length > MAX_HISTORY_ENTRIES) {
      conversationHistory.shift();
    }
  }

  function updateLastUserHistory(text: string) {
    if (!text.trim()) return;
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      if (conversationHistory[i].role === "user" && !conversationHistory[i].text.startsWith("[")) {
        conversationHistory[i].text = text.trim();
        return;
      }
    }
    pushHistory("user", text);
  }

  function enableTools() {
    if (toolsEnabled || !oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;
    toolsEnabled = true;
    oaiWs.send(JSON.stringify({
      type: "session.update",
      session: { type: "realtime", tool_choice: "auto" },
    }));
    log.info("Tools enabled (word threshold reached)");
  }

  function disableTools() {
    // Intentionally keep tools enabled across questions. Explicit user
    // navigation requests can arrive before the participant gives a
    // substantive answer, and those should still be able to transition.
  }

  let pendingTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  log.info(`Interview: "${ctx.title}" (${sortedQuestions.length} questions, lang=${ctx.language}, startQ=${currentQuestionIndex})`);

  function send(msg: Record<string, unknown>) {
    if (browserWs.readyState === WebSocket.OPEN)
      browserWs.send(JSON.stringify(msg));
  }

  function sendBinary(buf: Buffer) {
    if (browserWs.readyState === WebSocket.OPEN)
      browserWs.send(buf, { binary: true });
  }

  function clearPendingTransition() {
    if (pendingTransitionTimer) {
      clearTimeout(pendingTransitionTimer);
      pendingTransitionTimer = null;
    }
  }

  function sendQuestionPrompt(prompt: string, retriesLeft = 2) {
    pendingQuestionPrompt = prompt;
    if (pendingPromptTimer) clearTimeout(pendingPromptTimer);

    if (oaiWs?.readyState === WebSocket.OPEN && !reconnecting) {
      // Inject as a system message and trigger a response
      oaiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: prompt }],
        },
      }));
      requestAssistantResponse("question prompt");
    }

    pendingPromptTimer = setTimeout(() => {
      if (!pendingQuestionPrompt) return;
      if (retriesLeft > 0 && !browserClosed && !interviewDone) {
        log.warn(`No OpenAI response to question prompt — retrying (${retriesLeft} left)`);
        sendQuestionPrompt(prompt, retriesLeft - 1);
      } else {
        log.warn("OpenAI did not respond to question prompt after retries");
        pendingQuestionPrompt = null;
      }
    }, 5_000);
  }

  function clearQuestionPrompt() {
    pendingQuestionPrompt = null;
    if (pendingPromptTimer) {
      clearTimeout(pendingPromptTimer);
      pendingPromptTimer = null;
    }
  }

  function cancelOngoingResponse() {
    clearSilenceGapTimer();
    const shouldCancel =
      responseInFlight ||
      responseAudioStarted ||
      modelIsSpeaking ||
      !!outputTranscriptBuffer;
    if (shouldCancel && oaiWs && oaiWs.readyState === WebSocket.OPEN) {
      responseInFlight = false;
      oaiWs.send(JSON.stringify({ type: "response.cancel" }));
    }
    outputTranscriptBuffer = "";
    pendingTtsText = [];
    responseTtsBytes = 0;
    responseAudioStarted = false;
    responseAudioStartedAt = 0;
    modelIsSpeaking = false;
    ttsPlaybackEndsAt = 0;
  }

  function requestAssistantResponse(reason: string, response?: Record<string, unknown>) {
    clearSilenceGapTimer();
    if (
      !oaiWs ||
      oaiWs.readyState !== WebSocket.OPEN ||
      reconnecting ||
      isTransitioning ||
      (interviewDone && !pendingInterviewComplete)
    ) {
      return;
    }
    if (responseInFlight) {
      queuedAssistantResponse = { reason, response };
      log.info(`Queued assistant response (${reason}) while another response is active`);
      return;
    }
    const payload = response
      ? { type: "response.create", response }
      : { type: "response.create" };
    responseInFlight = true;
    oaiWs.send(JSON.stringify(payload));
    log.info(`Requested assistant response (${reason})`);
  }

  function takeQueuedAssistantResponse() {
    const next = queuedAssistantResponse;
    queuedAssistantResponse = null;
    return next;
  }

  function normalizeAsrGuardText(text: string): string {
    return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function shouldIgnoreStaleAsrText(text: string): boolean {
    if (!staleAsrGuardText || Date.now() > staleAsrGuardUntil) return false;
    const incoming = normalizeAsrGuardText(text);
    const previous = normalizeAsrGuardText(staleAsrGuardText);
    if (!incoming || !previous) return false;
    if (incoming === previous) return true;
    if (incoming.length >= 8 && previous.includes(incoming)) return true;
    if (previous.length >= 8 && incoming.includes(previous)) return true;
    return false;
  }

  function armStaleAsrGuard(text: string) {
    staleAsrGuardText = text;
    staleAsrGuardUntil = Date.now() + STALE_ASR_GUARD_MS;
  }

  function clearStaleAsrGuard() {
    staleAsrGuardText = "";
    staleAsrGuardUntil = 0;
  }

  function shouldSplitUserTurnOnSpeechStart(now = Date.now()): boolean {
    return (
      !speechTranscriptCommitted &&
      !!bestAvailableTranscript() &&
      !!lastVadSpeechEnd &&
      now - lastVadSpeechEnd >= USER_TURN_SPLIT_SILENCE_MS
    );
  }

  function handleCommittedUserText(committedText: string, reason: string): boolean {
    if (tryHandleExplicitUserNavigation(committedText)) {
      return true;
    }
    const currentQuestion = sortedQuestions[currentQuestionIndex];
    if (
      currentQuestion &&
      (currentQuestion.type === "CODING" || currentQuestion.type === "WHITEBOARD") &&
      isCodingDoneSignal(committedText) &&
      oaiWs &&
      oaiWs.readyState === WebSocket.OPEN
    ) {
      oaiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{
            type: "input_text",
            text: "[SYSTEM] The participant just said they are done with the coding/whiteboard task. Do NOT stay silent. Acknowledge briefly, then ask them to walk through their solution, including key tradeoffs and complexity.",
          }],
        },
      }));
    }
    requestAssistantResponse(reason);
    return false;
  }

  function clearSpeechFinalizeTimer() {
    if (pendingSpeechFinalize) {
      clearTimeout(pendingSpeechFinalize);
      pendingSpeechFinalize = null;
    }
  }

  function bestAvailableTranscript(): string {
    return mergeAsrText(inputTranscriptBuffer, volcAsrAccumulator).trim();
  }

  function noteTranscriptUpdate() {
    lastTranscriptUpdateAt = Date.now();
    if (!vadSpeechActive && !speechTranscriptCommitted && bestAvailableTranscript()) {
      scheduleSpeechFinalize("asr stability", USER_TRANSCRIPT_STABILITY_MS);
    }
  }

  function transcriptLooksStable(now = Date.now()): boolean {
    if (!lastTranscriptUpdateAt) return true;
    const sinceUpdate = now - lastTranscriptUpdateAt;
    const sinceSpeechStop = lastVadSpeechEnd ? now - lastVadSpeechEnd : Number.POSITIVE_INFINITY;
    return sinceUpdate >= USER_TRANSCRIPT_STABILITY_MS || sinceSpeechStop >= USER_TRANSCRIPT_MAX_WAIT_MS;
  }

  let lastCommittedUserTranscript = "";
  let lastCommittedUserTranscriptAt = 0;

  function commitUserTranscript(reason: string): string {
    clearSpeechFinalizeTimer();
    if (speechTranscriptCommitted) return "";

    const committedText = bestAvailableTranscript();
    if (!committedText) return "";

    if (isWhisperHallucination(committedText, ctx.language)) {
      log.info(`Dropped hallucination in commitUserTranscript (${reason}): ${JSON.stringify(committedText)}`);
      inputTranscriptBuffer = "";
      volcAsrAccumulator = "";
      return "";
    }

    speechTranscriptCommitted = true;
    lastCommittedUserTranscript = committedText;
    lastCommittedUserTranscriptAt = Date.now();
    pushHistory("user", committedText);
    send({ type: "asr_ended", text: committedText });
    log.info(`Committed user transcript (${reason}): ${JSON.stringify(committedText)}`);
    inputTranscriptBuffer = "";
    volcAsrAccumulator = "";
    lastTranscriptUpdateAt = 0;
    armStaleAsrGuard(committedText);
    return committedText;
  }

  function scheduleSpeechFinalize(reason: string, delayMs = 2000) {
    clearSpeechFinalizeTimer();
    pendingSpeechFinalize = setTimeout(() => {
      pendingSpeechFinalize = null;
      if (speechTranscriptCommitted || !bestAvailableTranscript()) return;
      if (!transcriptLooksStable()) {
        const now = Date.now();
        const waitForStability = Math.max(
          150,
          USER_TRANSCRIPT_STABILITY_MS - (now - lastTranscriptUpdateAt),
        );
        const waitForCap = lastVadSpeechEnd
          ? Math.max(150, USER_TRANSCRIPT_MAX_WAIT_MS - (now - lastVadSpeechEnd))
          : USER_TRANSCRIPT_STABILITY_MS;
        scheduleSpeechFinalize(reason, Math.min(waitForStability, waitForCap));
        return;
      }
      finalizeUserTurn(reason);
    }, delayMs);
  }

  function finalizeUserTurn(reason: string, requestResponse = true): string {
    const committed = commitUserTranscript(reason);
    if (committed && requestResponse) {
      handleCommittedUserText(committed, reason);
    }
    return committed;
  }

  function clearSilenceGapTimer() {
    if (silenceGapTimer) {
      clearTimeout(silenceGapTimer);
      silenceGapTimer = null;
    }
  }

  function startSilenceGapTimer(delayMs = INITIAL_THINKING_SILENCE_MS) {
    clearSilenceGapTimer();
    if (browserClosed || interviewDone || isTransitioning || modelIsSpeaking || responseInFlight) {
      return;
    }
    silenceGapTimer = setTimeout(() => {
      silenceGapTimer = null;
      handleSilenceGapTimeout();
    }, delayMs);
  }

  function handleSilenceGapTimeout() {
    if (browserClosed || interviewDone || isTransitioning || modelIsSpeaking || responseInFlight || vadSpeechActive) {
      return;
    }
    if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;

    // 1. If there is uncommitted speech in the buffer, flush and commit it
    if (!speechTranscriptCommitted && bestAvailableTranscript()) {
      log.info("Silence gap: flushing pending user transcript");
      const committed = finalizeUserTurn("silence gap - flush");
      if (committed) return;
    }

    const currentQuestion = sortedQuestions[currentQuestionIndex];
    const isCodingOrWhiteboard =
      currentQuestion &&
      (currentQuestion.type === "CODING" || currentQuestion.type === "WHITEBOARD");

    // 2. If user already spoke during this turn:
    // Consider the answer is DONE after 10s silence!
    if (userSpokeThisTurn) {
      log.info(`Silence gap (10s post-speech): considering user answer complete on Q${currentQuestionIndex + 1}`);
      userSpokeThisTurn = false;
      oaiWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: isZh
                  ? `[SYSTEM] 受访者在回答后已静默超过10秒。请将此视为该回答已完成。请以温和、富有参与感（engaging）的态度对他们所说的内容给予回应，并自然地提出跟进问题，或者在讨论充分后调用 signal_question_change 切换到下一题。`
                  : `[SYSTEM] The participant has finished speaking and remained silent for 10 seconds. Consider their answer complete. Engage warmly and thoughtfully with what they shared, and either ask a relevant follow-up question or call signal_question_change to transition to the next question if this question has been sufficiently discussed.`,
              },
            ],
          },
        })
      );
      requestAssistantResponse("silence gap - answer done");
    } else if (!nudgeSentThisTurn) {
      // 3. User has NOT spoken yet since the question was asked (after 30s initial thinking time):
      // Be engaging and warm! Check in gently.
      nudgeSentThisTurn = true;
      log.info(`Silence gap (30s thinking time): sending gentle check-in on Q${currentQuestionIndex + 1}`);

      const nudgePrompt = isCodingOrWhiteboard
        ? (isZh
          ? `[SYSTEM] 受访者在此任务上已沉默超过30秒。请用一句简短、温暖鼓励的话互动（例如：提醒他们可以慢慢思考，有想法可以随时说出来，随时可以向你提问）。保持在1句话内。`
          : `[SYSTEM] The participant has been silent for over 30 seconds on this coding/whiteboard task. Engage them warmly in 1 short sentence (e.g. remind them they can take their time, share their thoughts aloud as they work, or ask you questions anytime). Keep it to 1 sentence.`)
        : (isZh
          ? `[SYSTEM] 受访者在听到你的提问后已思考超过30秒。请展现更强的亲和力与参与感（more engaging），用1句温和友善的话互动（例如：提醒他们不用着急，可以慢慢思考；或者询问是否需要你换一种方式解释题目，帮助他们理清思路）。保持在1句话内。`
          : `[SYSTEM] The participant has been quietly thinking for over 30 seconds after your question. Be engaging and warm in 1 supportive sentence (e.g. let them know they can take their time to gather their thoughts, or ask if they would like you to clarify or rephrase the question). Keep it to 1 friendly sentence.`);

      oaiWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: nudgePrompt }],
          },
        })
      );
      requestAssistantResponse("silence gap - engagement nudge");
    }
  }

  function tryAcceptFreshAsrText(text: string, label: string): boolean {
    if (speechTranscriptCommitted) return false;
    if (!inputTranscriptBuffer && !volcAsrAccumulator && shouldIgnoreStaleAsrText(text)) {
      log.debug(`Ignored stale ${label}: ${JSON.stringify(text)}`);
      return false;
    }
    clearStaleAsrGuard();
    return true;
  }

  function emitInterimUserTranscript(text: string, allowWhenVolcSilent = false) {
    if (allowWhenVolcSilent && volcAsrAccumulator.trim()) return;
    send({ type: "asr", data: { results: [{ text }] } });
  }

  function handleVolcInterimText(text: string, label: string) {
    if (!tryAcceptFreshAsrText(text, label)) return;
    volcAsrAccumulator = mergeAsrText(volcAsrAccumulator, text);
    noteTranscriptUpdate();
    emitInterimUserTranscript(volcAsrAccumulator);
  }

  function handleVolcFinalText(reason: string, logLabel: string) {
    const userText = bestAvailableTranscript();
    if (userText && !volcAsrPreFlushed) {
      if (USE_VOLC_ASR_PRIMARY) {
        log.info(`${logLabel}: ${JSON.stringify(userText)}`);
        finalizeUserTurn(reason);
      } else {
        log.debug(`${logLabel} (interim-only): ${JSON.stringify(userText)}`);
        noteTranscriptUpdate();
        emitInterimUserTranscript(userText);
      }
    } else if (userText) {
      log.debug(`${logLabel} (skipped${volcAsrPreFlushed ? ", pre-flushed" : ""}${speechTranscriptCommitted ? ", committed" : ""}): ${JSON.stringify(userText)}`);
    }
    volcAsrPreFlushed = false;
  }

  function handleWhisperDelta(delta: string) {
    if (!delta || !tryAcceptFreshAsrText(delta, "Whisper delta")) return;
    inputTranscriptBuffer += delta;
    if (isWhisperHallucination(inputTranscriptBuffer, ctx.language)) {
      log.debug(`Interim hallucination suppressed: ${JSON.stringify(inputTranscriptBuffer)}`);
      return;
    }
    noteTranscriptUpdate();
    if (pendingAsrUpdate) clearTimeout(pendingAsrUpdate);
    pendingAsrUpdate = setTimeout(() => {
      pendingAsrUpdate = null;
      emitInterimUserTranscript(inputTranscriptBuffer, true);
    }, 150);
    if (pendingInputFlush) scheduleInputFlush();
  }

  function handleWhisperCompletedTranscript(transcript: string) {
    if (!transcript || !tryAcceptFreshAsrText(transcript, "Whisper completion")) return;

    const msSinceVadSpeech = Date.now() - lastVadSpeechEnd;
    if (isWhisperHallucination(transcript, ctx.language) || (msSinceVadSpeech > 10_000 && transcript.trim().split(/\s+/).length <= 6)) {
      log.debug(`ASR dropped (hallucination, ${msSinceVadSpeech}ms since VAD): ${JSON.stringify(transcript)}`);
      inputTranscriptBuffer = "";
      return;
    }

    log.info(`ASR completed: ${JSON.stringify(transcript)}`);
    inputTranscriptBuffer = mergeAsrText(inputTranscriptBuffer, transcript);
    noteTranscriptUpdate();
    if (pendingAsrUpdate) clearTimeout(pendingAsrUpdate);
    pendingAsrUpdate = null;
    emitInterimUserTranscript(inputTranscriptBuffer, true);
    scheduleInputFlush();
  }

  function handleSpeechStartedEvent() {
    log.debug("VAD: user speech started");
    speechStopForwardGraceUntil = 0;
    queuedAssistantResponse = null;
    clearSilenceGapTimer();
    userSpokeThisTurn = true;
    if (shouldSplitUserTurnOnSpeechStart()) {
      const splitText = bestAvailableTranscript();
      log.info(`Splitting pending user turn on new speech start: ${JSON.stringify(splitText)}`);
      finalizeUserTurn("speech restart", false);
    }
    cancelOngoingResponse();
    clearSpeechFinalizeTimer();
    vadSpeechActive = true;
    lastTranscriptUpdateAt = 0;
    if (speechTranscriptCommitted) {
      speechTranscriptCommitted = false;
      volcAsrAccumulator = "";
      inputTranscriptBuffer = "";
    }
    send({ type: "interrupt" });
  }

  function handleSpeechStoppedEvent() {
    vadSpeechActive = false;
    lastVadSpeechEnd = Date.now();
    speechStopForwardGraceUntil = lastVadSpeechEnd + SPEECH_STOP_FORWARD_GRACE_MS;
    log.debug("VAD: user speech stopped");
    if (!speechTranscriptCommitted && bestAvailableTranscript()) {
      scheduleSpeechFinalize("speech stop", USER_SPEECH_STOP_FINALIZE_MS);
    }
    startSilenceGapTimer(ANSWER_DONE_SILENCE_MS);
  }

  function flushPendingUserTurnBeforeAssistant() {
    if (!speechTranscriptCommitted && bestAvailableTranscript()) {
      const pendingUserText = bestAvailableTranscript();
      if (isWhisperHallucination(pendingUserText, ctx.language)) {
        log.info(`Dropped hallucination before assistant: ${JSON.stringify(pendingUserText)}`);
        inputTranscriptBuffer = "";
        volcAsrAccumulator = "";
        return;
      }
      if (transcriptLooksStable()) {
        volcAsrPreFlushed = true;
        log.info(`ASR pre-flush: ${JSON.stringify(pendingUserText)}`);
        finalizeUserTurn("response pre-flush");
      } else {
        log.info(`ASR pre-flush deferred: ${JSON.stringify(pendingUserText)}`);
        scheduleSpeechFinalize("response pre-flush", USER_TRANSCRIPT_STABILITY_MS);
      }
      return;
    }

    if (volcAsrAccumulator.trim()) {
      log.debug(`Volc ASR pre-flush skipped (already committed): ${JSON.stringify(volcAsrAccumulator.trim())}`);
      volcAsrAccumulator = "";
      volcAsrPreFlushed = true;
    }
  }

  function buildRealtimeAudioInputConfig() {
    const lang = (ctx.language || "en").slice(0, 2).toLowerCase();
    return {
      format: { type: "audio/pcm", rate: 24000 as const },
      noise_reduction: { type: "far_field" as const },
      transcription: {
        model: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
        language: lang === "zh" ? "zh" : "en",
      },
      turn_detection: {
        type: "server_vad" as const,
        threshold: 0.82,
        prefix_padding_ms: 300,
        silence_duration_ms: 1200,
        create_response: false,
      },
    };
  }

  function setOpenAiTranscriptionEnabled(enabled: boolean, reason: string) {
    // Keep OpenAI transcription active unless Volcengine is explicitly
    // the primary ASR and healthy.
    if (!enabled) {
      log.info(`OpenAI transcription kept warm (${reason})`);
      return;
    }
    if (openAiTranscriptionEnabled === enabled) return;
    openAiTranscriptionEnabled = enabled;
    log.info(`OpenAI transcription ${enabled ? "enabled" : "disabled"} (${reason})`);

    if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;
    oaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: enabled
            ? buildRealtimeAudioInputConfig()
            : {
                format: { type: "audio/pcm", rate: 24000 },
                noise_reduction: { type: "far_field" },
                turn_detection: {
                  type: "semantic_vad",
                  eagerness: "low",
                  create_response: false,
                  interrupt_response: true,
                },
              },
        },
      },
    }));
  }

  function markInterviewComplete(reason: string) {
    if (!pendingInterviewComplete) return;
    pendingInterviewComplete = false;
    if (interviewCompleteTimer) {
      clearTimeout(interviewCompleteTimer);
      interviewCompleteTimer = null;
    }
    send({ type: "interview_complete" });
    log.info(`Interview complete (${reason})`);
  }

  // ── Volcengine Big-Model streaming ASR ──────────────────────────────
  let volcWs: WebSocket | null = null;
  let volcAlive = false;
  let volcAsrAccumulator = "";
  let volcAsrPreFlushed = false;
  let volcKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let volcSessionErrorLogged = false;
  let volcAudioSeq = 1;

  async function connectVolcAsr() {
    if (!USE_VOLC_ASR_INTERIMS) return;
    if (volcKeepAliveTimer) { clearInterval(volcKeepAliveTimer); volcKeepAliveTimer = null; }
    try {
      const reqid = randomUUID().replace(/-/g, "");
      volcAudioSeq = 1;

      const asrConfig: BigModelAsrConfig = {
        format: "pcm",
        rate: 16000,
        bits: 16,
        channels: 1,
        codec: "raw",
        showUtterance: true,
        resultType: "single",
        enablePunc: true,
        endWindowSize: 500,
        forceToSpeechTime: 1000,
      };

      const wsHeaders = buildBigModelHeaders(VOLC_ASR_APPID, VOLC_ASR_TOKEN, reqid);
      volcWs = new WebSocket(BIGMODEL_ASR_URL, { headers: wsHeaders });

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Volcengine ASR connect timeout")), 10_000);
        volcWs!.on("open", () => { clearTimeout(t); resolve(); });
        volcWs!.on("error", (e) => { clearTimeout(t); reject(e); });
      });

      // Register message handler BEFORE sending the init request so we
      // don't miss the ACK or an early error.
      volcWs.on("message", (data: Buffer) => {
        try {
          const resp = parseAsrResponse(Buffer.from(data));

          // SERVER_ACK (0x0b) confirms the init or an audio chunk — mark alive on first one
          if (resp.messageType === 0x0b) {
            if (!volcAlive) {
              volcAlive = true;
              log.info("Volcengine Big-Model ASR connected (ACK received)");
              if (USE_VOLC_ASR_PRIMARY) {
                setOpenAiTranscriptionEnabled(false, "Volcengine ASR connected");
              }
            }
            return;
          }

          if (resp.errorCode || (resp.code && resp.code !== 1000)) {
            const code = resp.code || resp.errorCode;
            const isSessionDead = code === 45000081 || code === 55000000;
            if (!isSessionDead || !volcSessionErrorLogged) {
              log.warn(`Volcengine ASR error: code=${code} ${resp.message || resp.errorMessage || ""}`);
              if (isSessionDead) volcSessionErrorLogged = true;
            }
            if (!volcAlive) {
              volcAlive = false;
              setOpenAiTranscriptionEnabled(true, `Volcengine ASR error ${code}`);
              volcWs?.close();
            } else if (isSessionDead) {
              log.warn("Volcengine ASR session expired — reconnecting...");
              volcAlive = false;
              volcSessionErrorLogged = false;
              setOpenAiTranscriptionEnabled(true, "Volcengine ASR session expired");
              volcWs?.close();
            }
            return;
          }

          if (!volcAlive) return;

          if (resp.utterances && resp.utterances.length > 0) {
            const utt = resp.utterances[0];
            if (utt.text && !volcAsrPreFlushed) {
              handleVolcInterimText(utt.text, "Volc ASR");
            }
            if (utt.definite) {
              handleVolcFinalText("volc definite", "Volc ASR");
            }
          } else if (resp.text && !volcAsrPreFlushed) {
            handleVolcInterimText(resp.text, "Volc ASR final");

            if (resp.isLastPackage) {
              handleVolcFinalText("volc final", "Volc ASR final");
            }
          }
        } catch (err) {
          log.error("Volcengine ASR parse error:", err);
        }
      });

      volcWs.send(buildBigModelFullRequest(asrConfig, reqid));

      // Mark alive optimistically — the message handler above will set
      // volcAlive=true on ACK or false on error.  Audio forwarding
      // checks volcAlive so it's safe to start sending immediately.
      volcAlive = true;

      volcWs.on("close", () => {
        volcAlive = false;
        setOpenAiTranscriptionEnabled(true, "Volcengine ASR closed");
        if (!browserClosed && !interviewDone) reconnectVolcAsr();
      });

      volcWs.on("error", (err: Error) => {
        log.error("Volcengine ASR WS error:", err.message);
      });

      volcKeepAliveTimer = setInterval(() => {
        if (!volcAlive || !volcWs || volcWs.readyState !== WebSocket.OPEN) return;
        volcAudioSeq++;
        volcWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), volcAudioSeq));
      }, 5_000);

      log.info("Volcengine Big-Model ASR WebSocket open, waiting for ACK...");
    } catch (err) {
      log.error("Volcengine ASR connection failed:", err instanceof Error ? err.message : err);
      volcAlive = false;
      setOpenAiTranscriptionEnabled(true, "Volcengine ASR connection failed");
    }
  }

  function reconnectVolcAsr() {
    if (browserClosed || interviewDone) return;
    setTimeout(() => connectVolcAsr(), 2_000);
  }

  function cleanupVolcAsr() {
    volcAlive = false;
    setOpenAiTranscriptionEnabled(true, "Volcengine ASR cleanup");
    if (volcKeepAliveTimer) { clearInterval(volcKeepAliveTimer); volcKeepAliveTimer = null; }
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      try {
        volcAudioSeq++;
        volcWs.send(buildBigModelAudioRequest(Buffer.alloc(0), volcAudioSeq, true));
      } catch { /* ignore */ }
    }
    volcWs?.close();
    volcWs = null;
  }

  function sendAudioToVolc(pcm16kBuf: Buffer) {
    if (!volcAlive || !volcWs || volcWs.readyState !== WebSocket.OPEN) return;
    volcAudioSeq++;
    volcWs.send(buildBigModelAudioRequest(pcm16kBuf, volcAudioSeq));
  }

  // Start Volcengine Big-Model ASR
  connectVolcAsr();

  // Keepalive via WebSocket ping
  let lastAudioSentToOai = Date.now();
  const keepaliveTimer = setInterval(() => {
    if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;
    if ((Date.now() - lastAudioSentToOai) > 10_000) {
      try { oaiWs.ping(); } catch {}
    }
  }, 10_000);

  // Liveness check
  const LIVENESS_TIMEOUT_MS = 120_000;
  const LIVENESS_INPUT_WINDOW_MS = 60_000;
  const livenessTimer = setInterval(() => {
    if (browserClosed || interviewDone || reconnecting) return;
    if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const userRecentlyActive = (now - lastUserInput) < LIVENESS_INPUT_WINDOW_MS;
    const oaiSilent = (now - lastOaiActivity) > LIVENESS_TIMEOUT_MS;
    if (userRecentlyActive && oaiSilent) {
      log.warn("User is active but OpenAI silent for 2min — forcing reconnect");
      oaiWs.close();
    }
  }, 15_000);

  // ── OpenAI event handler ──────────────────────────────────────────

  function attachOaiHandlers(ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      if (ws !== oaiWs) return;
      lastOaiActivity = Date.now();
      try {
        const msg = JSON.parse(data.toString());

        // Log meaningful events (skip high-frequency audio/transcript deltas)
        if (msg.type && !msg.type.startsWith("response.output_audio.")
            && msg.type !== "response.output_audio_transcript.delta"
            && msg.type !== "input_audio_buffer.speech_started"
            && msg.type !== "input_audio_buffer.speech_stopped") {
          log.debug(`OAI event: ${msg.type}`);
        }

        switch (msg.type) {
          // ── Session lifecycle ──
          case "error": {
            const errorMessage = msg.error?.message || JSON.stringify(msg.error);
            if (/Cancellation failed: no active response found/i.test(errorMessage)) {
              responseInFlight = false;
              log.debug(`Ignoring benign OpenAI cancel error: ${errorMessage}`);
              break;
            }
            log.error("OpenAI error:", errorMessage);
            break;
          }

          case "response.created":
            responseInFlight = true;
            break;

          // ── ASR events (OpenAI Whisper fallback only) ──
          case "conversation.item.input_audio_transcription.delta": {
            if (!openAiTranscriptionEnabled || speechTranscriptCommitted) break;
            handleWhisperDelta(msg.delta || "");
            break;
          }

          case "conversation.item.input_audio_transcription.failed": {
            if (!openAiTranscriptionEnabled) break;
            const errMsg = msg.error?.message || JSON.stringify(msg.error);
            log.error(`ASR transcription failed: ${errMsg}`);
            break;
          }

          case "conversation.item.input_audio_transcription.completed": {
            if (!openAiTranscriptionEnabled) break;
            const transcript = (msg.transcript || "").trim();
            if (!transcript) break;

            if (isWhisperHallucination(transcript, ctx.language)) {
              log.debug(`Whisper hallucination dropped: ${JSON.stringify(transcript)}`);
              inputTranscriptBuffer = "";
              break;
            }

            // If user transcript was committed recently (e.g. early flush before ASR completed),
            // update it with the true completed transcript only if it is a genuine continuation
            // of the same speech, NOT an overwrite with a completely different sentence!
            if (speechTranscriptCommitted) {
              const now = Date.now();
              const isContinuation =
                transcript.length > lastCommittedUserTranscript.length &&
                transcript.toLowerCase().startsWith(lastCommittedUserTranscript.toLowerCase().slice(0, 10));
              if (
                !isWhisperHallucination(transcript, ctx.language) &&
                isContinuation &&
                now - lastCommittedUserTranscriptAt < 10_000
              ) {
                log.info(`Updating recent committed user transcript (${JSON.stringify(lastCommittedUserTranscript)}) with expanded ASR: ${JSON.stringify(transcript)}`);
                lastCommittedUserTranscript = transcript;
                lastCommittedUserTranscriptAt = now;
                send({ type: "asr_ended", text: transcript });
                updateLastUserHistory(transcript);
              }
              break;
            }

            handleWhisperCompletedTranscript(transcript);
            break;
          }

          // ── Model audio output ──
          case "response.output_audio.delta": {
            clearQuestionPrompt();
            modelIsSpeaking = true;
            if (!isTransitioning && msg.delta) {
              if (!responseAudioStarted) {
                responseAudioStarted = true;
                responseAudioStartedAt = Date.now();
                for (const t of pendingTtsText) send({ type: "tts_text", data: { text: t } });
                pendingTtsText = [];
              }
              lastTtsAudioTime = Date.now();
              const int16Buf = Buffer.from(msg.delta, "base64");
              const float32Buf = int16ToFloat32(int16Buf);
              responseTtsBytes += float32Buf.length;
              const chunkMs = Math.round((float32Buf.length / 96000) * 1000);
              ttsPlaybackEndsAt = Math.max(Date.now(), ttsPlaybackEndsAt) + chunkMs;
              sendBinary(float32Buf);
            } else if (isTransitioning && msg.delta) {
              log.warn("Audio suppressed: isTransitioning=true");
            }
            break;
          }

          // ── Model text transcript output ──
          case "response.output_audio_transcript.delta": {
            if (msg.delta) {
              outputTranscriptBuffer += msg.delta;
              if (responseAudioStarted) {
                send({ type: "tts_text", data: { text: msg.delta } });
              } else {
                pendingTtsText.push(msg.delta);
              }
            }
            break;
          }

          // ── Function call arguments complete ──
          case "response.function_call_arguments.done": {
            if (msg.name === "signal_question_change") {
              let args: { questionIndex?: number; userRequested?: boolean } = {};
              try { args = JSON.parse(msg.arguments || "{}"); } catch { /* ignore */ }
              const newIdx = args.questionIndex ?? (currentQuestionIndex + 1);
              const userRequested = args.userRequested === true;
              log.info(`OpenAI called signal_question_change → Q${newIdx + 1}${userRequested ? " (user requested)" : ""}`);

              // Already on the requested question — no-op, just tell the model.
              if (newIdx >= 0 && newIdx < sortedQuestions.length && newIdx === currentQuestionIndex) {
                log.info(`Already on Q${newIdx + 1}, ignoring duplicate signal_question_change`);
                pendingFunctionCalls.push({
                  callId: msg.call_id,
                  name: msg.name,
                  args: `You are already on question ${newIdx + 1}. Continue the conversation naturally — do NOT call signal_question_change again unless the participant is ready for a different question.`,
                });
                break;
              }

              // Reject premature transitions: block if the user hasn't spoken,
              // not enough time has passed, or insufficient words (forward only).
              // Backward transitions and explicit user requests bypass the word count guard.
              const dwellMs = Date.now() - questionEnteredAt;
              const isForward = newIdx > currentQuestionIndex && newIdx < sortedQuestions.length;
              const needsWordGuard = isForward && !userRequested;
              if (newIdx < sortedQuestions.length && (lastUserInput === 0 || dwellMs < MIN_QUESTION_DWELL_MS || (needsWordGuard && userCommittedWordsThisQuestion < MIN_WORDS_BEFORE_TRANSITION))) {
                const reason = lastUserInput === 0
                  ? "the participant has not spoken yet"
                  : (needsWordGuard && userCommittedWordsThisQuestion < MIN_WORDS_BEFORE_TRANSITION)
                    ? `only ${userCommittedWordsThisQuestion} word(s) from participant (minimum ${MIN_WORDS_BEFORE_TRANSITION})`
                    : `only ${Math.round(dwellMs / 1000)}s on this question (minimum ${MIN_QUESTION_DWELL_MS / 1000}s)`;
                log.warn(`Rejected premature question change: ${reason}`);
                pendingFunctionCalls.push({
                  callId: msg.call_id,
                  name: msg.name,
                  args: `Rejected: ${reason}. You MUST continue discussing question ${currentQuestionIndex + 1} and wait for a substantive response before calling signal_question_change. Do NOT verbally say you are moving to another question — the transition was blocked.`,
                });
                break;
              }

              clearPendingTransition();

              let result: string;
              if (newIdx >= sortedQuestions.length) {
                result = "Interview is now complete. Please give a brief farewell.";
              } else {
                result = `Moved to question ${newIdx + 1}: "${sortedQuestions[newIdx]?.text}". Please naturally transition and ask this question.`;
              }

              if (newIdx >= sortedQuestions.length) {
                if (!interviewDone) {
                  interviewDone = true;
                  pendingInterviewComplete = true;
                  log.info("Interview ending — waiting for farewell TTS to finish");
                  interviewCompleteTimer = setTimeout(() => {
                    if (pendingInterviewComplete) {
                      markInterviewComplete("timeout fallback");
                    }
                  }, 15_000);
                }
              } else if (newIdx >= 0 && newIdx !== currentQuestionIndex) {
                const dir = newIdx > currentQuestionIndex ? "next" : "previous";
                const arrow = dir === "next" ? "→" : "←";
                send({ type: "transitioning", auto: true, direction: dir });
                currentQuestionIndex = newIdx;
                questionEnteredAt = Date.now();
                userCommittedWordsThisQuestion = 0;
                userSpokeThisTurn = false;
                nudgeSentThisTurn = false;
                clearSilenceGapTimer();
                disableTools();
                send({
                  type: "question_change",
                  questionIndex: currentQuestionIndex,
                  totalQuestions: sortedQuestions.length,
                  auto: true,
                });
                pushHistory("user", `[Moved to question ${currentQuestionIndex + 1}: "${sortedQuestions[currentQuestionIndex]?.text}"]`);
                log.info(`${arrow} Q${currentQuestionIndex + 1}/${sortedQuestions.length}`);
              }

              // Store for batch response after response.done
              pendingFunctionCalls.push({
                callId: msg.call_id,
                name: msg.name,
                args: result,
              });
            }
            break;
          }

          // ── VAD events ──
          case "input_audio_buffer.speech_started":
            handleSpeechStartedEvent();
            break;

          case "input_audio_buffer.speech_stopped":
            handleSpeechStoppedEvent();
            break;

          // ── Response complete ──
          case "response.done": {
            const respStatus = msg.response?.status || "unknown";
            const respOutputCount = msg.response?.output?.length ?? 0;
            responseInFlight = false;
            const queuedResponse = takeQueuedAssistantResponse();

            // Flush pending ASR debounce
            if (pendingAsrUpdate) {
              clearTimeout(pendingAsrUpdate);
              pendingAsrUpdate = null;
              if (inputTranscriptBuffer) {
                send({ type: "asr", data: { results: [{ text: inputTranscriptBuffer }] } });
              }
            }

            const hadTts = !!(outputTranscriptBuffer || modelIsSpeaking);
            const capturedModelText = outputTranscriptBuffer;
            const completedFarewellTurn = pendingInterviewComplete && hadTts && responseTtsBytes > 0;
            outputTranscriptBuffer = "";
            modelIsSpeaking = false;
            const inferredFarewell =
              !pendingInterviewComplete &&
              currentQuestionIndex >= sortedQuestions.length - 1 &&
              !!capturedModelText &&
              looksLikeFarewell(capturedModelText, isZh);

            if (inferredFarewell) {
              interviewDone = true;
              pendingInterviewComplete = true;
              log.warn("Inferred interview completion from farewell text on final question");
            }

            if (hadTts && responseTtsBytes > 0) {
              ttsPlaybackEndsAt = Math.max(ttsPlaybackEndsAt, Date.now() + 500);
              // Flush any pending user text BEFORE committing agent text
              // so the transcript order matches the conversation order.
              flushPendingUserTurnBeforeAssistant();
              if (inputTranscriptBuffer) {
                flushUserInput();
              }
              if (capturedModelText) {
                log.info(`TTS done (${responseTtsBytes}B sent): ${JSON.stringify(capturedModelText)}`);
                pushHistory("assistant", capturedModelText);
              }
              send({ type: "tts_ended" });
              userSpokeThisTurn = false;
              startSilenceGapTimer(INITIAL_THINKING_SILENCE_MS);
            } else if (hadTts) {
              log.info(`TTS interrupted before audio (0B): ${JSON.stringify(capturedModelText)}`);
              pendingTtsText = [];
              if (lastUserInput === 0 && pendingFunctionCalls.length === 0 && !interviewDone) {
                log.warn("Greeting produced 0B audio — auto-retrying");
                requestAssistantResponse("greeting retry", { tool_choice: "none" });
              }
            }
            responseTtsBytes = 0;
            responseAudioStarted = false;
            responseAudioStartedAt = 0;

            // Detect empty responses and retry: the model sometimes
            // produces responses with no audio and no function calls.
            if (!hadTts && pendingFunctionCalls.length === 0 && respOutputCount === 0 && !interviewDone && !queuedResponse) {
              emptyResponseRetries++;
              if (emptyResponseRetries <= MAX_EMPTY_RETRIES) {
                log.warn(`Empty response (status=${respStatus}, attempt ${emptyResponseRetries}/${MAX_EMPTY_RETRIES}) — nudging model to speak`);
                requestAssistantResponse(`empty response retry ${emptyResponseRetries}`);
              } else {
                log.error(`Empty response (status=${respStatus}) — exhausted retries, giving up`);
                emptyResponseRetries = 0;
              }
            } else if (hadTts) {
              emptyResponseRetries = 0;
            }

            // Send function call results and trigger follow-up response
            if (pendingFunctionCalls.length > 0) {
              if (queuedResponse) {
                queuedAssistantResponse = queuedResponse;
              }
              const calls = [...pendingFunctionCalls];
              pendingFunctionCalls = [];
              for (const fc of calls) {
                ws.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: fc.callId,
                    output: fc.args,
                  },
                }));
              }
              requestAssistantResponse("function call follow-up");
            } else if (queuedResponse) {
              requestAssistantResponse(`queued after ${queuedResponse.reason}`, queuedResponse.response);
            }

            if (completedFarewellTurn) {
              markInterviewComplete("after farewell");
            }

            if (inputTranscriptBuffer) {
              scheduleInputFlush();
            }
            break;
          }
        }
      } catch (err) {
        log.error("Error parsing OpenAI message:", err);
      }
    });

    ws.on("close", () => {
      if (ws !== oaiWs) return;
      const sessionDuration = ((Date.now() - oaiSessionStart) / 1000).toFixed(1);
      log.info(`OpenAI WS closed (session lasted ${sessionDuration}s)`);
      oaiWs = null;

      if (browserClosed || interviewDone) return;

      if (pendingInputFlush) { clearTimeout(pendingInputFlush); pendingInputFlush = null; }
      if (pendingAsrUpdate) { clearTimeout(pendingAsrUpdate); pendingAsrUpdate = null; }

      if (inputTranscriptBuffer) {
        pushHistory("user", inputTranscriptBuffer);
      }
      if (outputTranscriptBuffer) {
        pushHistory("assistant", outputTranscriptBuffer);
        outputTranscriptBuffer = "";
      }
      modelIsSpeaking = false;
      pendingFunctionCalls = [];

      send({ type: "session_reconnecting" });

      log.info("Attempting auto-reconnect...");
      reconnectOai().catch((err) => {
        log.error("Reconnect failed:", err);
        if (browserWs.readyState === WebSocket.OPEN) {
          send({ type: "disconnected" });
          browserWs.close();
        }
      });
    });

    ws.on("error", (err: Error) => {
      log.error("OpenAI WS error:", err.message);
    });
  }

  // ── OpenAI connection ─────────────────────────────────────────────

  async function connectOai(): Promise<WebSocket> {
    const ws = new WebSocket(OPENAI_WS_URL, {
      headers: OPENAI_WS_HEADERS,
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("OpenAI connect timeout")), 10_000);
      ws.on("open", () => { clearTimeout(t); resolve(); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });

    // Wait for session.created and log default config
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Session create timeout")), 10_000);
      const h = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session.created") {
            clearTimeout(t);
            ws.removeListener("message", h);
            log.info("Session created — default config keys:", Object.keys(msg.session || {}));
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(t);
            ws.removeListener("message", h);
            log.error("OpenAI session.create error:", msg.error);
            reject(new Error(msg.error?.message || "Session create error"));
          }
        } catch { /* ignore */ }
      };
      ws.on("message", h);
    });

    const systemPrompt = buildSystemPrompt(ctx, currentQuestionIndex);

    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: systemPrompt,
        output_modalities: ["audio"],
        audio: {
          input: buildRealtimeAudioInputConfig(),
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: AZURE_VOICE,
          },
        },
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
      },
    }));

    // Wait for session.updated and log effective config
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Session update timeout")), 10_000);
      const h = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session.updated") {
            clearTimeout(t);
            ws.removeListener("message", h);
            const s = msg.session || {};
            const audioIn = s.audio?.input || {};
            log.info("Session updated — transcription:", JSON.stringify(audioIn.transcription), "turn_detection:", audioIn.turn_detection?.type, "noise_reduction:", JSON.stringify(audioIn.noise_reduction));
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(t);
            ws.removeListener("message", h);
            log.error("Session update error:", JSON.stringify(msg.error));
            reject(new Error(msg.error?.message || "Session update error"));
          }
        } catch { /* ignore */ }
      };
      ws.on("message", h);
    });

    return ws;
  }

  async function reconnectOai() {
    if (reconnecting) return;
    reconnecting = true;
    const MAX_RETRIES = 3;

    await new Promise((r) => setTimeout(r, 500));

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        log.info(`Reconnect attempt ${attempt}/${MAX_RETRIES}...`);

        const ws = await connectOai();
        oaiWs = ws;
        oaiSessionStart = Date.now();
        lastOaiActivity = Date.now();
        lastAudioSentToOai = Date.now();
        attachOaiHandlers(ws);

        // OpenAI doesn't have session resumption tokens —
        // replay conversation history to restore context.
        let codeContext = "";
        if (latestCode) {
          codeContext = `\n\nThe participant's current code (${latestCodeLanguage}):\n\`\`\`${latestCodeLanguage}\n${latestCode}\n\`\`\``;
        }
        const resumePrompt = `[SYSTEM] Session reconnected. The UI currently shows question ${currentQuestionIndex + 1}: "${sortedQuestions[currentQuestionIndex]?.text}".${codeContext}\nDo NOT re-introduce yourself, re-ask the current question, or repeat anything you've already said. Wait silently for the participant to speak, then respond naturally. If you were in the middle of saying something, do NOT repeat it.`;

        if (conversationHistory.length > 0) {
          const MAX_REPLAY_TURNS = 12;
          const recentHistory = conversationHistory.length > MAX_REPLAY_TURNS
            ? conversationHistory.slice(-MAX_REPLAY_TURNS)
            : conversationHistory;

          for (const h of recentHistory) {
            ws.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: h.role,
                content: [{ type: h.role === "assistant" ? "output_text" : "input_text", text: h.text }],
              },
            }));
          }
          log.info(`Replayed ${recentHistory.length}/${conversationHistory.length} history turns`);
        }

        // Send resume prompt as system message
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: resumePrompt }],
          },
        }));

        log.info("Reconnected successfully");
        reconnecting = false;
        send({ type: "session_reconnected" });

        if (pendingQuestionPrompt) {
          const prompt = pendingQuestionPrompt;
          pendingQuestionPrompt = null;
          if (pendingPromptTimer) { clearTimeout(pendingPromptTimer); pendingPromptTimer = null; }
          sendQuestionPrompt(prompt);
        }
        return;
      } catch (err) {
        log.warn(`Reconnect attempt ${attempt} failed:`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    reconnecting = false;
    throw new Error("All reconnect attempts failed");
  }

  // ── Initial connection ────────────────────────────────────────────

  try {
    oaiWs = await connectOai();
    oaiSessionStart = Date.now();
    log.info("OpenAI session established");
    attachOaiHandlers(oaiWs);

    send({ type: "ready", sessionId: "openai-session" });
    send({
      type: "question_change",
      questionIndex: currentQuestionIndex,
      totalQuestions: sortedQuestions.length,
    });

    // Give the browser time to set up its AudioContext before streaming audio
    await new Promise((r) => setTimeout(r, 1_500));

    // Trigger initial greeting ONLY on the very first question when starting fresh.
    // If reconnecting/resuming on an existing question, wait silently for candidate speech.
    if (currentQuestionIndex === 0) {
      const greeting = "The participant has just joined. Please greet them warmly and begin with question 1.";
      oaiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `[SYSTEM] ${greeting}` }],
        },
      }));
      requestAssistantResponse("initial greeting", { tool_choice: "none" });
    } else {
      log.info(`Resuming on Q${currentQuestionIndex + 1} — waiting silently for participant speech`);
      startSilenceGapTimer(INITIAL_THINKING_SILENCE_MS);
    }
  } catch (err) {
    log.error("Failed to connect to OpenAI:", err);
    send({
      type: "error",
      message: `OpenAI connection failed: ${err instanceof Error ? err.message : err}`,
    });
    browserWs.close();
    return;
  }

  // ── Handle Browser → OpenAI ───────────────────────────────────────

  function requestTransition(
    targetIdx: number,
    directionLabel: string,
    reason: "button" | "user_request" = "button",
  ) {
    clearPendingTransition();
    clearQuestionPrompt();
    clearSilenceGapTimer();
    cancelOngoingResponse();

    isTransitioning = true;
    const direction = targetIdx > currentQuestionIndex ? "next" : "previous";
    send({ type: "transitioning", direction });

    setTimeout(() => {
      if (targetIdx === currentQuestionIndex) {
        isTransitioning = false;
        return;
      }
      if (targetIdx >= sortedQuestions.length) {
        isTransitioning = false;
        if (!interviewDone) {
          interviewDone = true;
          pendingInterviewComplete = true;
          log.info("Interview ending (button) — waiting for farewell");
          interviewCompleteTimer = setTimeout(() => {
            if (pendingInterviewComplete) {
              markInterviewComplete("timeout fallback");
            }
          }, 15_000);
        }
        return;
      }
      const dir = targetIdx > currentQuestionIndex ? "→" : "←";
      currentQuestionIndex = targetIdx;
      questionEnteredAt = Date.now();
      userCommittedWordsThisQuestion = 0;
      userSpokeThisTurn = false;
      nudgeSentThisTurn = false;
      clearSilenceGapTimer();
      disableTools();
      pushHistory("user", `[Moved to question ${currentQuestionIndex + 1}: "${sortedQuestions[currentQuestionIndex]?.text}"]`);
      send({
        type: "question_change",
        questionIndex: currentQuestionIndex,
        totalQuestions: sortedQuestions.length,
      });
      isTransitioning = false;
      log.info(`${dir} Q${currentQuestionIndex + 1}/${sortedQuestions.length}`);

      const prompt = reason === "user_request"
        ? `[SYSTEM] The participant explicitly asked to go ${directionLabel.toLowerCase()}. We are now on question ${currentQuestionIndex + 1}: "${sortedQuestions[currentQuestionIndex]?.text}". Briefly acknowledge the transition and introduce this question now.`
        : `[SYSTEM] The participant clicked "${directionLabel}". We are now on question ${currentQuestionIndex + 1}: "${sortedQuestions[currentQuestionIndex]?.text}". Briefly introduce this question now.`;
      sendQuestionPrompt(prompt);
    }, 500);
  }

  function tryHandleExplicitUserNavigation(text: string): boolean {
    const userText = text.trim();
    if (!userText || isTransitioning || interviewDone) return false;

    if (isFastPrevRequest(userText) || isUserPrevRequest(userText)) {
      if (currentQuestionIndex <= 0) return false;
      log.info(`Fast-path PREV transition from user: "${userText}"`);
      requestTransition(currentQuestionIndex - 1, "Previous Question", "user_request");
      return true;
    }

    if (isFastNextRequest(userText) || isUserSkipRequest(userText)) {
      const nextIdx = Math.min(currentQuestionIndex + 1, sortedQuestions.length);
      if (nextIdx === currentQuestionIndex) return false;
      log.info(`Fast-path NEXT transition from user: "${userText}"`);
      requestTransition(nextIdx, "Next Question", "user_request");
      return true;
    }

    return false;
  }

  browserWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "next_question") {
        log.info("Browser requested next question");
        const nextIdx = Math.min(currentQuestionIndex + 1, sortedQuestions.length);
        if (nextIdx !== currentQuestionIndex) {
          requestTransition(nextIdx, "Next Question");
        }
        return;
      }
      if (msg.type === "prev_question") {
        log.info("Browser requested previous question");
        const prevIdx = Math.max(currentQuestionIndex - 1, 0);
        if (prevIdx !== currentQuestionIndex) {
          requestTransition(prevIdx, "Previous Question");
        }
        return;
      }
      if (msg.type === "ping") {
        send({ type: "pong" });
        return;
      }

      if (reconnecting) return;
      if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;

      if (msg.type === "audio" && msg.data) {
        if (isTransitioning) return;
        const rawPcm = Buffer.from(msg.data, "hex");
        const is24k = msg.sampleRate === 24000;
        const pcm24k = is24k ? rawPcm : resample16to24(rawPcm);
        const nowMs = Date.now();

        const samples = new Int16Array(rawPcm.buffer, rawPcm.byteOffset, rawPcm.length / 2);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / (samples.length || 1));

        lastUserInput = nowMs;
        const inEchoCooldown = (nowMs - lastTtsAudioTime) < TTS_ECHO_COOLDOWN_MS || nowMs < ttsPlaybackEndsAt;

        const bargeInFrameEligible =
          inEchoCooldown &&
          modelIsSpeaking &&
          responseAudioStarted &&
          responseAudioStartedAt > 0 &&
          nowMs - responseAudioStartedAt >= DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS &&
          responseTtsBytes >= DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES &&
          rms >= TTS_BARGE_IN_RMS;
        if (bargeInFrameEligible) {
          ttsBargeInFrames += 1;
        } else {
          ttsBargeInFrames = 0;
        }
        const allowBargeInDuringTts = shouldAllowTtsBargeIn({
          inEchoCooldown,
          modelIsSpeaking,
          responseAudioStarted,
          ttsAudioStartedAt: responseAudioStartedAt,
          nowMs,
          responseTtsBytes,
          rms,
          thresholdRms: TTS_BARGE_IN_RMS,
          consecutiveFrames: ttsBargeInFrames,
          thresholdFrames: TTS_BARGE_IN_FRAME_COUNT,
        });

        if (allowBargeInDuringTts) {
          log.info(`Allowing TTS barge-in after sustained speech (rms=${Math.round(rms)})`);
          ttsBargeInFrames = 0;
          cancelOngoingResponse();
          send({ type: "interrupt" });
        }

        const canForwardAudio = !inEchoCooldown || allowBargeInDuringTts;

        if (!userSpeechGateOpen) {
          if (rms >= VOICE_ATTACK_RMS && canForwardAudio) {
            voiceAttackFrames += 1;
            if (voiceAttackFrames >= VOICE_ATTACK_FRAME_COUNT) {
              userSpeechGateOpen = true;
              lastVoiceEnergyTime = nowMs;
              clearSilenceGapTimer();

              // Flush pre-roll buffer so the beginning phonemes are never clipped
              if (audioPreRoll.length > 0) {
                for (const chunk of audioPreRoll) {
                  oaiWs.send(JSON.stringify({
                    type: "input_audio_buffer.append",
                    audio: chunk.toString("base64"),
                  }));
                }
                audioPreRoll = [];
              }
            }
          } else {
            voiceAttackFrames = 0;
            if (canForwardAudio) {
              audioPreRoll.push(pcm24k);
              if (audioPreRoll.length > MAX_PRE_ROLL_CHUNKS) {
                audioPreRoll.shift();
              }
            } else {
              audioPreRoll = [];
            }
          }
        } else {
          if (rms >= VOICE_SUSTAIN_RMS) {
            lastVoiceEnergyTime = nowMs;
          } else if (nowMs - lastVoiceEnergyTime >= VOICE_HANGOVER_MS) {
            userSpeechGateOpen = false;
            voiceAttackFrames = 0;
            audioPreRoll = [];
          }
        }
        const hasRecentVoiceEnergy = userSpeechGateOpen;

        if (canForwardAudio && hasRecentVoiceEnergy) {
          lastAudioSentToOai = Date.now();
          oaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm24k.toString("base64"),
          }));
        }
        if (canForwardAudio && rms >= MIN_AUDIO_RMS) {
          sendAudioToVolc(rawPcm);
        }
        } else if (msg.type === "text_input" && msg.content) {
          const text = (msg.content as string).trim();
          if (text) {
            lastUserInput = Date.now();
            queuedAssistantResponse = null;
            pushHistory("user", text);
          if (tryHandleExplicitUserNavigation(text)) {
            return;
          }
          send({ type: "interrupt" });
          // Cancel any ongoing response, send text as user message, trigger new response
          cancelOngoingResponse();
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            },
          }));
          requestAssistantResponse("text input");
        }
      } else if (msg.type === "code_update") {
        const content = (msg.content as string) || "";
        const language = (msg.language as string) || "plaintext";
        latestCode = content;
        latestCodeLanguage = language;
        if (content) {
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text:
                `[CODE_UPDATE] The participant's current code (${language}):\n\`\`\`${language}\n${content}\n\`\`\``,
              }],
            },
          }));
          // Acknowledge silently so it doesn't trigger a response
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "(Noted the code update.)" }],
            },
          }));
        }
      } else if (msg.type === "text" && msg.content) {
        oaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: `[SYSTEM] Please say the following aloud: ${msg.content}` }],
          },
        }));
        requestAssistantResponse("system say-aloud");
      } else if (msg.type === "whiteboard_update") {
        const imageDataUrl = (msg.imageDataUrl as string) || "";
        if (imageDataUrl) {
          // Send as an image in a user message
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{
                type: "input_image",
                image_url: imageDataUrl,
              }],
            },
          }));
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "(Received whiteboard update.)" }],
            },
          }));
          log.info("Whiteboard image sent to OpenAI");
        }
      }
    } catch (err) {
      log.error("Error handling browser message:", err);
    }
  });

  browserWs.on("close", () => {
    log.info("Browser disconnected");
    browserClosed = true;
    clearInterval(keepaliveTimer);
    clearInterval(livenessTimer);
    clearPendingTransition();
    clearQuestionPrompt();
    clearSilenceGapTimer();
    cleanupVolcAsr();
    if (pendingInputFlush) clearTimeout(pendingInputFlush);
    if (pendingAsrUpdate) clearTimeout(pendingAsrUpdate);
    if (interviewCompleteTimer) clearTimeout(interviewCompleteTimer);
    oaiWs?.close();
  });

  browserWs.on("error", (err) => {
    log.error("Browser WS error:", err.message);
  });
}
