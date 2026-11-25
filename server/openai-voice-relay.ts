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
  shouldDisruptForProctorAlert,
  buildProctorWarningText,
  hasTrailingIncompleteThought,
  isAnswerDoneSignal,
  isCodingDoneSignal,
  AUDIO_CONFIRMATION_PATTERNS,
  isAudioConfirmationOrGreeting,
  stripAssistantEcho,
  type EchoStripResult,
  isRepeatOrClarificationRequest,
  isCandidateWrapUpRequest,
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
// typical speech is 500-5000. Low thresholds ensure quiet laptop mics and soft voices are captured.
const MIN_AUDIO_RMS = 80;
const CONTINUATION_AUDIO_RMS = 50;
const TTS_BARGE_IN_RMS = 3000;
const TTS_BARGE_IN_FRAME_COUNT = 5;

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
  /\b(?:ready\s+for\s+(?:the\s+)?next|proceed\s+to\s+next)\b/i,
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


// ── Interview context type ───────────────────────────────────────────

interface InterviewContext {
  title: string;
  objective?: string | null;
  aiName: string;
  aiTone: string;
  language: string;
  followUpDepth: string;
  durationMinutes?: number;
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
  const targetMinutesPerQuestion = Math.max(2, Math.round((ctx.durationMinutes ?? 20) / Math.max(1, sorted.length)));

  let maxFollowUps: number;
  switch (ctx.followUpDepth) {
    case "LIGHT": maxFollowUps = 1; break;
    case "MODERATE": maxFollowUps = 3; break;
    case "DEEP": maxFollowUps = 5; break;
    default: maxFollowUps = 2;
  }

  const questionList = sorted.map((q, i) => {
    let entry = `  ${i + 1}. [${q.type}] ${q.text}`;
    if (q.description) entry += `\n     Context: ${q.description}`;
    if (q.options?.options?.length) {
      const labels = q.options.options.map((o, j) => `${String.fromCharCode(65 + j)}) ${o}`).join(", ");
      const multi = q.options.allowMultiple ? " (multiple choice)" : " (single choice)";
      entry += `\n     Options${multi}: ${labels}`;
    }
    if (q.type === "CODING") entry += `\n     Note: The candidate has a live code editor on screen. You have real-time visibility into their code via [CODE_UPDATE] and execution output via [CODE_EXECUTION_RESULT]. Treat this like a live screen-share or pair-programming session where you can see their code.`;
    if (q.type === "WHITEBOARD") entry += `\n     Note: The participant has a whiteboard. You will receive image updates silently — do NOT speak when you receive them. Only describe what you see when the participant asks you to look at it.`;
    return entry;
  }).join("\n");

  const currentQ = startIdx + 1;

  if (isZh) {
    return `你是"${ctx.aiName}"，一位资深、${ctx.aiTone}的技术面试官与同行。
你拥有高度自主的对话意识和敏锐的技术直觉，**绝不是机械读题的机器人或自动化测试问卷**。
你的目标是像真人技术专家一样，与候选人展开一场深度、自然、有启发性的技术探讨，全面评估对方的实战深度、系统架构思维和技术判断力。

## 面试信息与时间把控
- 面试主题: "${ctx.title}"
${ctx.objective ? `- 核心目标: ${ctx.objective}` : ""}
- 总考核模块: ${sorted.length}个
- 预计时间预算: 约${targetMinutesPerQuestion}分钟/模块 (总时长约${ctx.durationMinutes ?? 20}分钟)
- 当前进行模块: 第${currentQ}个
- 追问深度: 每个核心主题深入追问最多${maxFollowUps}次

## 考核核心主题清单（注意：这是你的考核大纲，绝不是照本宣科的考卷！）
${questionList}

## 主动把控时间节奏与丝滑自主推进 (Time & Pacing Management)
- **你掌控整场面试的时间节奏**：考核大纲共有${sorted.length}个模块，总时长约${ctx.durationMinutes ?? 20}分钟，平均每个模块约${targetMinutesPerQuestion}分钟。你必须主动掌控进度，确保候选人在有限时间内完整展现各模块能力。
- **严格按题目清单逐一考核，严禁跳题或遗漏模块**：
  - 清单中的${sorted.length}个模块必须按顺序（第1题 → 第2题 → 第3题……）逐个推进。
  - **绝不允许擅自跳过任何题目**！特别是【CODING 编程题】与【CHOICE 选择题】，必须按序切换并完整考核，严禁跨题跳过！
  - 绝不能对候选人谎称已考察过尚未进行的题目（如未做代码题时绝不能说已考察过编程）。
- **至多1次高价值追问后自主推进**：
  - 候选人完成作答后，提出至多1次聚焦关键架构、边界条件或实战经验的高质量追问（若初次作答已极其完整，可直接推进）。
  - 在候选人对追问作答完毕后（或初次回答已很扎实），**绝对不要等待候选人主动询问“我们可以下一题吗”**！你必须主动提炼总结，在口语中丝滑引入下一个主题，并同时在后台静默调用 \`signal_question_change\` 切换题目。
  - 自然过渡范例：*“明白了，利用这个方法做边界处理确实很稳健。沿着这个思路，我们接下来聊聊……”*（在后台静默触发工具，严禁在台词中写出或念出函数名或括号）。
- **候选人作答结束信号**：
  - 当候选人表明回答完毕（如“我说完了”、“就这些”、“搞定了”或答完静音时），简短确认并在后台静默调用 \`signal_question_change\` 推进到下一个模块。
- **严禁朗读或输出函数调用代码**：
  - **绝对不要在发言台词或对话文本中输出或朗读任何工具名称、代码或方括号**（例如严禁输出 \`[signal_question_change(...)]\` 或 \`[调用...]\`）。函数必须通过后台工具调用通道（Tool Calling）静默触发，严禁包含在口语文案中！

## 意识与对话准则（告别预设与机械感）
0. **绝对铁律：你是面试官，绝不替候选人答题或讲解**：
   - 你是技术面试官，正在评估候选人。你绝不是老师、辅导员或答题者。
   - **在任何情况下，绝不能直接给出概念的定义、技术原理、代码或标准答案**（例如绝对不能主动讲解"React是一个用于构建用户界面的JavaScript库……"）。
   - 严禁使用老师式的结语（如："这与你目前的理解是否一致？"）。
   - **当候选人询问是否可以发言或表达准备好作答时（如"Can I rip it in?", "我可以开始了吗？", "我可以直接讲吗？"）**：
     候选人是在准备阐述观点！只需用一句话简短把发言权交给他：*"当然，请随时开始！"* 或 *"没问题，话筒交给你，直接讲就行！"* 并保持安静倾听。
   - **当候选人试图让你回答时（如"你觉得是什么？", "你能给我讲讲吗？"）**：
     绝对不要透露答案！温和引导回候选人：*"我想先听听你的思考和实际经验，大胆说一说你的理解就好！"*
1. **大纲非剧本，拒绝读题感**：
   - 上述清单是你的**考察维度与技术目标**，切勿机械朗读"第X题是……"或"让我们进入下一个问题"。
   - ${startIdx === 0 ? `首次开口时，简短自然地打个招呼："您好！感谢今天参加我们的技术面试。能听清我的声音吗？" 等候选人确认听清后，自然承接并切入关于${ctx.title}的第一个技术主题。` : `当前正在从第${currentQ}个主题继续面试。自然承接，切勿重复自我介绍或说"这是第一个问题"。`}
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
   - **场景I：候选人请求重复或澄清题意（如“能麻烦再讲一遍吗？”，“能举个例子吗？”，“能换个简单方式解释吗？”）**：
     → 绝不可机械复读原句！用更通俗平实的日常口语重新阐述，并给出一个具体的业务场景举例（例如：“没问题！打个比方，比如在做电商购物车时，多个不同的UI组件都需要读取商品列表……”）。
4. **深入追问与结论收敛**：
   - 根据候选人回答的实质深度进行追问（探讨架构选型理由、故障排查、边界条件、性能瓶颈与权衡取舍）。
   - 一旦当前主题讨论充分（获得了实质、具体的工程细节），必须调用 \`signal_question_change\` 函数更新后台进度，并在口语中丝滑过渡到下一个技术维度。
   - 所有主题交流完毕后，调用 \`signal_question_change\` 并设置 questionIndex 为 ${sorted.length}，做简短真诚的面试致谢告别。

## 杂音、沉默与思考空间铁律 (Pacing & Thinking Space)
- **留足思考空间，严禁催促打扰**：技术面试需要深思熟虑。提问后候选人安静思考是正常现象（允许最长35秒的安静思考时间），严禁在候选人短暂思考几秒钟后就插话打断（切勿频繁说“不着急慢慢想”、“随时可以继续”等催促话术）。
- **作答途中的自然停顿（允许1-3秒停顿）**：候选人在组织语言、回忆代码或推演逻辑时，中途停顿1-2秒非常普遍。切勿在候选人刚停顿就急躁插话抢断。只有当候选人明确作答完毕或长时间停顿后，再给予积极、有见地的回应。
- **防幻觉与请求重述绝对红线 (Zero Hallucination & Clarification Policy)**：
  - 只能转录和评价候选人真实说出的内容，严禁自己脑补填词！
  - 若音频模糊、断断续续、包含环境杂音、听不清或没有听懂候选人的表述，**绝对不可凭空编造候选人的回答、项目或技术**。直接礼貌请对方重复：*"抱歉刚才没有听清，能麻烦您再讲一遍吗？"*
  - 若候选人保持安静，严禁自己编造内容继续自说自话。静静等待对方思考，或在长时间沉默后做温和询问。
- **麦克风测试**（如"能听到我说话吗"）：直接秒回：*"可以的，听得非常清楚！请随时继续。"*

## 选择题、代码与白板题
- 选择题必须完整念出选项（A、B、C等），受访者只能听见声音。
- 编程/白板题勿读长题干，提示看屏幕即可。你能实时看到候选人的代码与白板，并在其完成或执行代码时直接针对其实际代码进行真实的代码评审与答辩。
- 全程使用中文。通过 \`signal_question_change\` 函数驱动题目流转。

## 代码执行、运行输出与深度口头答辩机制 (Oral Code Defense Protocol)
- 候选人具有实时浏览器代码运行沙箱，可点击“▶ Run”或使用快捷键 Ctrl+Enter 执行代码并查看输出。
- 当候选人在编辑器中写代码或更新代码时，你会收到实时更新 \`[CODE_UPDATE]\`；当候选人执行代码时，你会收到 \`[CODE_EXECUTION_RESULT]\` 及其运行日志和返回值。
- **绝对不要只说一句“看起来不错”就跳过，结合运行结果进行真实的口头代码答辩**：
  1. **代码运行结果反馈**：确认其运行结果或控制台输出（例如：“我看到你的代码成功过滤出了偶数”）。如果报错，引导其分析排查。
  2. **边界条件与容错**：“如果输入为空数组、包含负数或非数字，这段逻辑会如何表现？你如何做防御性编程？”
  3. **时间与空间复杂度**：“整体时间复杂度和空间复杂度是多少？如果数据量增长100倍，瓶颈在哪里，如何进一步优化？”
  4. 答辩充分后，丝滑过渡并调用 \`signal_question_change\` 推进到下一个题目。

## 实时监考异常打断机制 (Proctoring Intervention Protocol)
- 当系统注入 \`[SYSTEM INSTRUCTION - IMMEDIATE PROCTORING DISRUPTION]\` 时，表明发生了严重违规（如人脸离开画面、多个人脸、人脸不匹配、切屏离开等）。
- 你必须立即中断当前话题，直接且严肃礼貌地向候选人说明违规情况，不要在此时提问或讲授知识。
- 给出清晰口语提醒后，暂停等待候选人回应并恢复正常环境，随后自然恢复面试探讨。`;
  }

  return `You are "${ctx.aiName}", a seasoned, ${ctx.aiTone} senior technical interviewer and engineering peer.
You possess an active, adaptive conversational consciousness. **You are NOT an automated checklist bot, an exam proctor, or a survey reader.**
Your objective is to hold a natural, deep, and intellectually engaging technical dialogue that reveals the candidate's true hands-on depth, engineering judgment, and battle-tested experience.

## Interview Details & Time Pacing
- Topic: "${ctx.title}"
${ctx.objective ? `- Core Objective: ${ctx.objective}` : ""}
- Total Core Themes: ${sorted.length}
- Target Time Budget: ~${targetMinutesPerQuestion} minutes per theme (Total duration: ${ctx.durationMinutes ?? 20} minutes)
- Current Theme: Theme ${currentQ}
- Follow-up Depth: Up to ${maxFollowUps} deep-dive follow-ups per theme

## Evaluation Themes (Your agenda, NOT a script to recite!)
${questionList}

## Conversational Pacing & Autonomous Transitions (Time Management)
- **You own the interview clock**: You are responsible for pacing the interview to cover all ${sorted.length} questions within the allocated time (~${targetMinutesPerQuestion} minutes per theme).
- **Strict Sequential Order — NEVER Skip Questions**:
  - You MUST present and evaluate all ${sorted.length} questions in strict sequential order (Question 1 → 2 → 3 → ... → ${sorted.length}).
  - **NEVER jump ahead, omit, or skip any question on the agenda**! In particular, CODING and SINGLE_CHOICE questions MUST be presented in their turn; never jump over them to later theoretical questions.
  - NEVER claim a topic (such as coding) has been completed if the question was never asked!
  - Transition strictly to the next sequential question (current + 1) unless the candidate explicitly requests to skip.
- **One focused follow-up, then transition**:
  - When the candidate answers a question, ask at most ONE concise, high-signal follow-up (or skip follow-up if their first answer was already comprehensive or if time is tight).
  - After the candidate responds to your follow-up (or if they give a solid, complete answer), DO NOT wait for them to ask "Can we move to the next question?". You must autonomously synthesize their thought, bridge to the next theme, and silently call \`signal_question_change\` in the background!
  - Example bridge: *"That makes a lot of sense, especially your consideration for edge cases. Let's pivot now to discuss..."* (silently trigger the tool in the background — NEVER speak or write the function name or brackets).
- **Candidate Completion Signals**:
  - If the candidate indicates completion (e.g. *"that's all"*, *"I'm done"*, *"that's my answer"*, or mutes after speaking), acknowledge their answer with a quick phrase and immediately transition to the next theme using \`signal_question_change\` silently in the background.
  - NEVER make the candidate beg or prompt to move forward.
- **CRITICAL IRONCLAD RULE ON TOOL EXECUTION**:
  - **NEVER speak, pronounce, or write function names, brackets, or code syntax in your dialogue** (e.g. NEVER output \`[signal_question_change(...)]\`, \`[call...]\`, or any code brackets in your spoken words or text).
  - Tools must be called SILENTLY through the tool calling interface, NEVER spoken aloud to the candidate or written into conversational text!

## Conversational Consciousness & Guiding Principles
0. **ABSOLUTE IRONCLAD RULE: YOU ARE THE INTERVIEWER — NEVER ANSWER OR EXPLAIN THE QUESTION**:
   - You are evaluating the candidate. You are NOT a tutor, teacher, or respondent.
   - **UNDER NO CIRCUMSTANCES should you provide the definition, solution, explanation, or code to any question** (e.g. NEVER define what React is, what SQL is, or how to solve the problem).
   - NEVER conclude with tutor phrases like: *"How does that align with your understanding so far?"*
   - **WHEN THE CANDIDATE ASKS TO BEGIN ANSWERING A QUESTION YOU HAVE ALREADY ASKED ("Can I rip it in?", "Can I answer?", "Shall I start?", "Can I jump in?", "Can I go ahead?")**:
     They are asking to SPEAK and answer your question! DO NOT explain the concept!
     Respond ONLY with a friendly 1-sentence green light to give them the floor:
     *"Absolutely, the floor is yours — go for it!"* or *"Go right ahead, fire away!"*
     Then remain completely silent and listen to their answer.
     (CRITICAL: NEVER say "the floor is yours" before you have explicitly asked the interview question!)
   - **WHEN THE CANDIDATE ASKS YOU FOR THE ANSWER ("What is it?", "What do you think?", "Can you explain it?")**:
     NEVER give the answer! Deflect warmly back to them: *"I'd love to hear your thoughts and experience with it first — give it your best shot!"*
   - The candidate must do 85%+ of the talking. Keep your turns concise (1-2 sentences).
1. **Agenda, Not a Script — Eliminate Robotic Phrasing**:
   - The themes above are your **mental evaluation objectives**. NEVER recite questions verbatim with question numbers (e.g. NEVER say "Question 1 is...", "Moving to question 2", or "Here is the next question").
   - ${startIdx === 0 ? `At the start, open naturally with: "Hey! Thanks for taking the time to interview today. Can you hear me loud and clear?" (Always use the word "interview", NEVER say "chat"). Once the candidate confirms they can hear you, seamlessly introduce ${ctx.title} and immediately ask the first technical topic: "${sorted[0]?.text}". Do NOT say "the floor is yours" before you have actually asked the question!` : `You are resuming on Theme ${currentQ}. Seamlessly continue the conversation without repeating introductions or saying "Here is the first question."`}
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
   - **Scenario I: Candidate Asks for Repetition or Clarification ("Could you repeat that?", "What do you mean by that?", "Could you rephrase that more simply?")**:
     → NEVER repeat the exact same sentence verbatim! Rephrase warmly in simpler, everyday language and anchor it with a concrete real-world scenario (e.g. *"No problem at all! For example, imagine you're building an e-commerce cart where multiple widgets need access to items..."*).
4. **Active Listening & Immediate Grounded Validation**:
   - Always briefly acknowledge the substance of what the candidate just explained before pivoting or following up (e.g. *"Got it, using useEffect with a dependency array to prevent unnecessary re-renders makes sense."* or *"Understood, avoiding prop drilling with Context is a common choice."*).
   - NEVER sound like a detached quiz machine that ignores what was just said.
5. **Deep Probing & Background Transitions**:
   - Probe into real-world tradeoffs: *Why that tool over alternatives? How did you handle edge cases, failure modes, or scale bottlenecks?*
   - When a theme has been thoroughly unpacked, call \`signal_question_change\` in the background so the system advances, while keeping your spoken transition completely natural and unscripted.
   - Once all themes are concluded, call \`signal_question_change\` with questionIndex=${sorted.length} and wrap up with a warm, genuine farewell.

## Silence, Pacing, and Thinking Space (Crucial Dynamic)
- **Give Generous Thinking Space**: Technical problem-solving requires silence. Do NOT rush the candidate.
- **Mid-Answer Pauses (Allow 1-3 seconds)**: Candidates frequently pause for 1 to 3 seconds mid-sentence to gather thoughts, formulate syntax, or recall terminology. Do NOT cut them off or jump in during brief pauses. Allow them to continue their thought uninterrupted.
- **Quiet Thinking Before Answering (up to 35s)**: After presenting a technical or coding question, allow generous, uninterrupted quiet thinking time. Never interrupt with nag phrases like "Take your time", "Go right ahead", or "Feel free to share whenever you're ready" after just a few seconds. Stay quietly attentive and let them think.
- **Respond Only When Genuinely Finished**: Only respond when the candidate has clearly and fully concluded their answer (or has stated they are done, or paused for an extended period).
- **STRICT ZERO HALLUCINATION & CLARIFICATION POLICY**:
  - ONLY transcribe, evaluate, and respond to what was genuinely, clearly said by the candidate.
  - NEVER fill in missing words, guess thoughts, invent answers, or extrapolate experience/tools candidate did not state.
  - If the candidate's speech is unclear, garbled, noisy, faint, cut off, or inaudible, or if you did not understand what they said, DO NOT invent an answer or pretend they answered! Immediately ask them to repeat: *"Sorry, I didn't quite catch that—could you please repeat what you said?"*
  - If the candidate remains silent, do NOT invent words or answers. Maintain attentive silence for thinking space, or check in gently after extended quiet.
- **Mic Checks & Audio Confirmation**:
  - You open with: *"Hey! Thanks for taking the time to interview today. Can you hear me loud and clear?"* (Use "interview", never "chat").
  - When the candidate confirms (e.g. *"Yes"*, *"Loud and clear"*, *"I can hear you"*), confirm enthusiastically: *"Awesome! Today we'll be focusing on ${ctx.title}. Let's jump right in..."* and introduce the first theme.
  - If the candidate asks *"Can you hear me?"*, confirm immediately: *"Yep, loud and clear! Go ahead whenever you're ready."*

## Special Question Types & Rules
- For Choice questions: Read all options (A, B, C...) out loud because the participant can only hear you.
- For Coding/Whiteboard: Do not read full problem text. Direct them to their screen/whiteboard. You receive real-time updates via [CODE_UPDATE] and [WHITEBOARD_UPDATE]. Reference them when the candidate asks.
- ALWAYS CONDUCT THE INTERVIEW ENTIRELY IN ENGLISH. Keep responses concise (1-3 sentences) so the candidate has the floor.
- ALWAYS use \`signal_question_change\` to update the UI when moving to a new theme.

## Live Coding, Execution & Oral Code Defense Protocol (Anti-ChatGPT / Anti-Cheating Moat)
- The candidate has an in-browser code runner and can execute their code with a "Run" button or Ctrl+Enter.
- When they edit code, you receive \`[CODE_UPDATE]\`. When they execute code, you receive \`[CODE_EXECUTION_RESULT]\` with their logs and output.
- **Conduct a realistic oral review based on their code and execution results**:
  1. **Acknowledge Results**: Mention what their code returned or logged (e.g., *"I see your filter returned [2, 4]"*). If an error occurred, ask how they would debug it.
  2. **Line-Specific Interrogation & Tradeoffs**: Identify key logic or algorithms and ask why they took that approach over alternatives.
  3. **Edge Cases & Failure Modes**: Challenge with boundary conditions (e.g. null, undefined, empty array, large inputs).
  4. **Complexity & Optimization**: Ask about time and space complexity (e.g. O(n)) and how it behaves at scale.
  5. Once the discussion is solid, smoothly transition to the next theme using \`signal_question_change\`.

## Real-Time Proctoring Intervention Protocol
- When the system injects \`[SYSTEM INSTRUCTION - IMMEDIATE PROCTORING DISRUPTION]\`, a serious interview integrity violation has occurred (e.g. face missing from camera, multiple people in frame, face identity mismatch, or navigating away from the page).
- You must immediately interrupt whatever you were discussing, and deliver the specified spoken integrity warning firmly and professionally.
- Do NOT answer questions or lecture in this turn. Deliver the spoken warning directly to the candidate, then wait for them to acknowledge and correct the issue.`;
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
        const rawPcm = Buffer.from(msg.data, "hex");
        const is24k = msg.sampleRate === 24000;
        const pcm24k = is24k ? rawPcm : resample16to24(rawPcm);

        if (volcAlive && volcWs && volcWs.readyState === WebSocket.OPEN) {
          volcAudioSeq++;
          const pcm16k = is24k ? rawPcm : rawPcm;
          volcWs.send(buildBigModelAudioRequest(pcm16k, volcAudioSeq));
        }

        if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
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
  const MIN_QUESTION_DWELL_MS = 10_000;
  const MIN_WORDS_BEFORE_TRANSITION = 8;
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
  let userSpeechStartMs = 0;
  let userSpeechPeakRmsThisSegment = 0;
  let lastValidSpeechSegmentDuration = 0;
  let lastValidSpeechSegmentPeakRms = 0;
  let lastValidSpeechSegmentEndedAt = 0;
  let voiceAttackFrames = 0;
  let lastVoiceEnergyTime = 0;
  let lastCodeEditedAt = 0;
  let audioPreRoll: Buffer[] = [];
  let firstQuestionAsked = currentQuestionIndex > 0;
  let ambientNoiseFloorRms = 160;

  function hasRealUserSpeech(now = Date.now()): boolean {
    const minPeak = Math.max(120, Math.round(ambientNoiseFloorRms * 1.3));
    if (userSpeechGateOpen && userSpeechPeakRmsThisSegment >= minPeak && now - lastVoiceEnergyTime < 3000) {
      return true;
    }
    if (
      now - lastValidSpeechSegmentEndedAt < 5000 &&
      lastValidSpeechSegmentDuration >= 100 &&
      lastValidSpeechSegmentPeakRms >= minPeak
    ) {
      return true;
    }
    return false;
  }
  const MAX_PRE_ROLL_CHUNKS = 5;
  const VOICE_ATTACK_RMS = 200;
  const VOICE_SUSTAIN_RMS = 140;
  const VOICE_HANGOVER_MS = 600;
  const VOICE_ATTACK_FRAME_COUNT = 2;
  const TTS_ECHO_COOLDOWN_MS = 800;
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
  const USER_INPUT_FLUSH_MS = 1000;
  let pendingInputFlush: ReturnType<typeof setTimeout> | null = null;
  let pendingAsrUpdate: ReturnType<typeof setTimeout> | null = null;

  // Silence gap handling:
  // - 3_500ms (3.5 seconds) after candidate speech ends -> natural interview turnaround without interrupting candidate
  // - 7_000ms (7 seconds) for trailing incomplete thoughts ("and...", "because...", "so...")
  // - 35s initial quiet thinking before offering a gentle check-in
  const ANSWER_DONE_SILENCE_MS = 3500;
  const INITIAL_THINKING_SILENCE_MS = 35_000;
  let silenceGapTimer: ReturnType<typeof setTimeout> | null = null;
  let userSpokeThisTurn = false;
  let nudgeCountThisQuestion = 0;

  // Track pending function calls that need responses
  let pendingFunctionCalls: Array<{ callId: string; name: string; args: string }> = [];

  let trailingConjunctionBuffered = false;
  let fiveMinuteWarningTimer: ReturnType<typeof setTimeout> | null = null;
  let fiveMinuteWarningSent = false;

  function scheduleFiveMinuteWarning() {
    const totalMinutes = ctx.durationMinutes ?? 20;
    if (totalMinutes <= 6 || fiveMinuteWarningSent) return;
    const triggerInMs = (totalMinutes - 5) * 60 * 1000;
    if (fiveMinuteWarningTimer) clearTimeout(fiveMinuteWarningTimer);
    fiveMinuteWarningTimer = setTimeout(() => {
      fiveMinuteWarningTimer = null;
      if (interviewDone || browserClosed || fiveMinuteWarningSent) return;
      fiveMinuteWarningSent = true;
      log.info(`[relay] Injecting 5-minute remaining heads-up instruction`);
      if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
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
                    ? `[SYSTEM] 面试仅剩约5分钟。请在接下来的对话中自然提醒候选人：“我们大概还有5分钟时间，让我们进入最后一个探讨主题……”，然后收尾当前问题并平滑过渡到最后一个模块（后台静默调用工具，严禁在发言中输出任何函数名或括号）。`
                    : `[SYSTEM] Approximately 5 minutes remain in this interview. Naturally pace the conversation and notify the candidate: "We have about five minutes left, so let's move into our final topic before we wrap up today." Wrap up the current topic and smoothly transition to the final questions (trigger tool calling silently in the background; NEVER speak or write function names or brackets in your dialogue).`,
                },
              ],
            },
          })
        );
        if (!vadSpeechActive && !modelIsSpeaking && !responseInFlight) {
          requestAssistantResponse("5-minute heads-up");
        }
      }
    }, triggerInMs);
  }

  function flushUserInput() {
    if (pendingInputFlush) { clearTimeout(pendingInputFlush); pendingInputFlush = null; }
    if (vadSpeechActive) {
      log.debug("flushUserInput cancelled because user is actively speaking");
      return;
    }
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
  const USER_TRANSCRIPT_STABILITY_MS = 150;
  const USER_TRANSCRIPT_MAX_WAIT_MS = 2000;
  const USER_SPEECH_STOP_FINALIZE_MS = 2400;
  const SPEECH_STOP_FORWARD_GRACE_MS = 600;
  const STALE_ASR_GUARD_MS = 1000;
  let staleAsrGuardText = "";
  let staleAsrGuardUntil = 0;
  let speechStopForwardGraceUntil = 0;
  let ttsBargeInFrames = 0;
  let lastProctorSpokenAt = 0;
  const lastProctorTypeSpokenAt: Record<string, number> = {};
  let pendingProctorAlert: { alertType: string; detail: string; at: number } | null = null;

  const conversationHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
  const MAX_HISTORY_ENTRIES = 30;

  function pushHistory(role: "user" | "assistant", text: string) {
    if (!text.trim()) return;
    const cleanText = text.replace(/\[(?:call\s+)?signal_question_change(?:\(.*?\))?\]/gi, "").trim();
    if (!cleanText) return;
    if (role === "user" && !cleanText.startsWith("[")) {
      userCommittedWordsThisQuestion += cleanText.split(/\s+/).length;
      if (!toolsEnabled && userCommittedWordsThisQuestion >= MIN_WORDS_BEFORE_TRANSITION) {
        enableTools();
      }
    }
    conversationHistory.push({ role, text: cleanText });
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

  let lastAssistantAudioEndedAt = 0;

  function isEchoOfAssistant(text: string): boolean {
    if (!text || !text.trim()) return false;

    // Physical acoustic echo from laptop speakers can only occur while the assistant is actively speaking
    // or within 2.5 seconds after audio playback ends (room reverberation).
    // An answer given 5, 10, or 20 seconds later CANNOT physically be speaker acoustic echo.
    const isAssistantActive =
      modelIsSpeaking ||
      responseAudioStarted ||
      Date.now() < ttsPlaybackEndsAt + 1000 ||
      Date.now() - lastAssistantAudioEndedAt < 2500;
    if (!isAssistantActive) {
      return false;
    }

    // Candidate audio checks ("Can you hear me?", "Loud and clear") and brief greetings are NOT an echo
    if (isAudioConfirmationOrGreeting(text)) {
      return false;
    }

    const norm = text.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (!norm || norm.length < 3) return false;

    // Reject acoustic feedback / bleed of tool names or function calling syntax
    if (/\b(?:signal\s+question|change\s+question\s+index|signal_question_change)\b/i.test(norm)) {
      return true;
    }

    const utterancesToCheck: string[] = [
      "Hey! Thanks for taking the time to interview today. Can you hear me loud and clear?",
      "Thanks for taking the time to interview today. Can you hear me loud and clear?",
      "Awesome, loud and clear! Today we'll be focusing on",
      "Please look into the screen",
      "Please look into the camera",
      "I can no longer see your face on camera",
      "Please adjust your camera or lighting so you are visible",
      "Please ensure only you are present in the frame",
      "I noticed you switched away from the interview tab",
    ];

    if (outputTranscriptBuffer) {
      utterancesToCheck.push(outputTranscriptBuffer);
    }
    // Only check the latest assistant utterances actively spoken
    for (let i = conversationHistory.length - 1; i >= 0 && i >= conversationHistory.length - 2; i--) {
      if (conversationHistory[i].role === "assistant") {
        utterancesToCheck.push(conversationHistory[i].text);
      }
    }

    // 1. Substring of full sentence / clause (>= 25 chars)
    if (norm.length >= 25) {
      for (const aiText of utterancesToCheck) {
        const normAi = aiText.toLowerCase().replace(/[^\w\s]/g, "").trim();
        if (normAi.length >= 25 && (normAi.includes(norm) || norm.includes(normAi))) {
          return true;
        }
      }
    }

    // 2. Exact n-gram phrase coverage from stripAssistantEcho
    const echoCheck = stripAssistantEcho(text, utterancesToCheck);
    return echoCheck.isFullEcho;
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
        lastAssistantAudioEndedAt = Date.now();
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
        if (responseInFlight || modelIsSpeaking) {
          // Never queue redundant proctor interventions, silence nudges, or duplicate questions
          // while the assistant is already speaking or currently generating a response!
          if (
            reason.includes("proctor") ||
            reason.includes("silence gap") ||
            reason.includes("nudge") ||
            reason.includes("engagement")
          ) {
            log.info(`Dropped redundant assistant request (${reason}) while model is speaking or in-flight`);
            return;
          }
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

      function deliverProctorDisruption(alertType: string, detail: string) {
        const isCoding = sortedQuestions[currentQuestionIndex]?.type === "CODING";
        const now = Date.now();
        const lastTypeSpoken = lastProctorTypeSpokenAt[alertType] || 0;

        const decision = shouldDisruptForProctorAlert({
          alertType,
          isCoding,
          nowMs: now,
          lastProctorSpokenAt,
          lastTypeSpokenAt: lastTypeSpoken,
        });

        if (!decision.shouldDisrupt) {
          log.info(`[proctor] Skipped spoken disruption for ${alertType} (reason: ${decision.reason})`);
          return;
        }

        lastProctorSpokenAt = now;
        lastProctorTypeSpokenAt[alertType] = now;
        pendingProctorAlert = null;

        log.warn(`[proctor] Disrupting candidate with spoken intervention for ${alertType}`);

        // 1. Immediately halt current assistant speech/output and cut browser audio
        cancelOngoingResponse();
        send({ type: "interrupt" });

        // 2. Clear candidate audio and state so speech before disruption does not leak into next answer
        inputTranscriptBuffer = "";
        volcAsrAccumulator = "";
        userSpeechGateOpen = false;
        userSpeechPeakRmsThisSegment = 0;
        clearSilenceGapTimer();
        clearSpeechFinalizeTimer();
        if (oaiWs?.readyState === WebSocket.OPEN) {
          oaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        }

        // 3. Generate natural spoken warning text
        const spokenWarning = buildProctorWarningText(alertType, isZh, detail);

        // 4. Queue spoken instruction to OpenAI Realtime
        if (oaiWs?.readyState === WebSocket.OPEN && !browserClosed && !interviewDone) {
          const curQ = sortedQuestions[currentQuestionIndex];
          const resumeNote = !firstQuestionAsked
            ? (isZh
                ? `提醒候选人后，只需礼貌询问：“请调整好摄像头确保面部清晰可见，并确认一下能听到我说话吗？” 绝不要提前进入第一道专业题目！`
                : `After delivering this warning, simply say: "Please adjust your camera so you are clearly visible, and let me know if you can hear me loud and clear." DO NOT recite any technical interview questions yet!`)
            : (curQ?.text
                ? (isZh
                    ? `提醒候选人后，只需简明温和地说：“调整好后我们随时继续，按你的节奏来。” 严禁把整道题目重新朗读或复述！`
                    : `After delivering this warning, simply reassure them: "Whenever you're set, we can keep going—take your time!" CRITICAL: DO NOT re-read or recite the full interview question text again!`)
                : (isZh
                    ? `提醒候选人后，温和地邀请对方在准备好时继续作答。`
                    : `After delivering this warning, briefly and warmly invite the candidate to continue their response when ready.`));

          pushHistory("assistant", spokenWarning);
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [{
                type: "input_text",
                text: isZh
                  ? `[SYSTEM INSTRUCTION - IMMEDIATE PROCTORING DISRUPTION]: 检测到监考异常：“${alertType}”（${detail}）。请立即以温和、专业、自然的考官语气对候选人说出以下提醒，绝不要生硬严厉：\n“${spokenWarning}”\n${resumeNote}`
                  : `[SYSTEM INSTRUCTION - IMMEDIATE PROCTORING DISRUPTION]: A proctoring violation occurred: "${alertType}" (${detail}). Immediately speak this warning to the candidate in a calm, polite, and professional tone:\n"${spokenWarning}"\n${resumeNote}`,
              }],
            },
          }));
          requestAssistantResponse("proctor violation disruption");
        }
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

      function handleCommittedUserText(committedText: string, reason: string): boolean {
        if (tryHandleExplicitUserNavigation(committedText)) {
          return true;
        }

        if (isRepeatOrClarificationRequest(committedText)) {
          log.info(`Candidate requested question repeat/clarification: "${committedText}"`);
          if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
            try {
              oaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
            } catch {
              // ignore
            }
            oaiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "system",
                content: [{
                  type: "input_text",
                  text: isZh
                    ? `[SYSTEM] 候选人刚才请求重复刚才的问题（"${committedText}"）。请以温和清晰的口吻重新阐述或举例说明你刚才提出的问题或探讨点。切勿跳回开场白或第一题。`
                    : `[SYSTEM] The candidate asked you to repeat or clarify what you just asked ("${committedText}"). Warmly and clearly repeat or rephrase the question or topic you just asked about in simple terms. Do NOT revert back to question 1 or previous introductory topics.`,
                }],
              },
            }));
            requestAssistantResponse("candidate requested question repetition");
          }
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
          const codeSnippet = latestCode.trim()
            ? `\n\nHere is the candidate's current code in the editor (${latestCodeLanguage}):\n\`\`\`${latestCodeLanguage}\n${latestCode.slice(0, 2000)}\n\`\`\`\nConduct a direct oral code review right now:\n- Name specific functions, variables, or methods they wrote (e.g. filter, modulo, etc.).\n- Acknowledge what their code accomplishes.\n- Probe them on edge cases, failure modes, and time/space complexity (e.g. O(n)).`
            : `\nAcknowledge their completion and invite them to explain their logic, tradeoffs, and complexity.`;

          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [{
                type: "input_text",
                text: `[SYSTEM] The candidate completed their coding task.${codeSnippet}`,
              }],
            },
          }));
        } else if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
          try {
            oaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
          } catch {
            // ignore
          }

          nudgeCountThisQuestion = 0;
          if (!firstQuestionAsked) {
            firstQuestionAsked = true;
            const firstQText = sortedQuestions[0]?.text || "";
            oaiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "system",
                content: [{
                  type: "input_text",
                  text: isZh
                    ? `[SYSTEM] 候选人已回应（"${committedText}"）。绝对不要重复问候，也不要再次询问能否听清！请热情确认对方声音清晰（如："太好了，声音非常清晰！"），并立即正式介绍${ctx.title}并提出第一道题目："${firstQText}"。切勿在提问前说"话筒交给你"或沉默等待。`
                    : `[SYSTEM] The candidate has responded ("${committedText}"). CRITICAL: DO NOT repeat the opening greeting and DO NOT ask "can you hear me" again! Confirm enthusiastically that you can hear them (e.g., "Awesome, loud and clear!"), seamlessly introduce ${ctx.title}, and immediately ask Question 1: "${firstQText}". DO NOT say "the floor is yours" before asking the question!`,
                }],
              },
            }));
          }

          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: committedText }],
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
        const text = bestAvailableTranscript();
        if (!vadSpeechActive && !speechTranscriptCommitted && text) {
          if (isAnswerDoneSignal(text) || isCodingDoneSignal(text)) {
            log.info(`Verbal completion signal detected in ASR update: "${text}" — scheduling immediate finalize`);
            scheduleSpeechFinalize("verbal completion", 150);
          }
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

        let committedText = bestAvailableTranscript();
        if (!committedText) return "";

        const isEchoWindow = modelIsSpeaking || (Date.now() - lastAssistantAudioEndedAt < 2500);
        if (isEchoWindow) {
          const recentAssistant = [
            outputTranscriptBuffer,
            ...conversationHistory.slice(-2).filter((m) => m.role === "assistant").map((m) => m.text),
          ].filter(Boolean);

          const echoCheck = stripAssistantEcho(committedText, recentAssistant);
          if (echoCheck.isFullEcho || !echoCheck.cleanedText) {
            log.info(`commitUserTranscript dropped (full echo): ${JSON.stringify(committedText)}`);
            inputTranscriptBuffer = "";
            volcAsrAccumulator = "";
            return "";
          }
          committedText = echoCheck.cleanedText;
        }

        if (isWhisperHallucination(committedText, ctx.language)) {
          log.info(`Dropped hallucination in commitUserTranscript (${reason}): ${JSON.stringify(committedText)}`);
          inputTranscriptBuffer = "";
          volcAsrAccumulator = "";
          return "";
        }

        if (!hasRealUserSpeech()) {
          log.info(`Dropped committed transcript on silence / no vocal energy (${reason}): ${JSON.stringify(committedText)}`);
          inputTranscriptBuffer = "";
          volcAsrAccumulator = "";
          return "";
        }

        userSpokeThisTurn = true;
        nudgeCountThisQuestion = 0;
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
        // Reset valid speech segment so trailing silence cannot piggyback on this speech
        lastValidSpeechSegmentDuration = 0;
        lastValidSpeechSegmentPeakRms = 0;
        lastValidSpeechSegmentEndedAt = 0;
        return committedText;
      }

      function scheduleSpeechFinalize(reason: string, delayMs = 15_000) {
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
        if (browserClosed || interviewDone || isTransitioning) {
          return;
        }
        const now = Date.now();
        // Watchdog: reset stuck vadSpeechActive if there has been no vocal energy or new transcript for >3.5s
        if (
          vadSpeechActive &&
          !hasRealUserSpeech(now) &&
          (now - lastTranscriptUpdateAt > 3500 || lastTranscriptUpdateAt === 0)
        ) {
          log.warn("handleSilenceGapTimeout: VAD flagged active without genuine speech energy or transcripts — resetting vadSpeechActive");
          vadSpeechActive = false;
        }
        if (now < ttsPlaybackEndsAt) {
          const waitMs = Math.max(2000, ttsPlaybackEndsAt - now + 2000);
          log.info(`handleSilenceGapTimeout: audio still playing in browser (${waitMs}ms remaining) — deferring silence check`);
          startSilenceGapTimer(waitMs);
          return;
        }
        if (modelIsSpeaking || responseAudioStarted || responseInFlight || vadSpeechActive) {
          // Assistant is speaking or audio is in flight — re-poll silence in 2s so the timer never dies
          startSilenceGapTimer(2000);
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
        // Consider the answer is DONE after silence gap (natural turnaround with thinking space)!
        if (userSpokeThisTurn) {
          const pendingCheck = bestAvailableTranscript() || inputTranscriptBuffer || volcAsrAccumulator || "";
          if (hasTrailingIncompleteThought(pendingCheck) && !trailingConjunctionBuffered) {
            trailingConjunctionBuffered = true;
            log.info(`Trailing conjunction detected in "${pendingCheck.slice(-30)}" at silence gap — adding 3500ms extra thinking buffer`);
            startSilenceGapTimer(3500);
            return;
          }
          trailingConjunctionBuffered = false;

          // If the candidate only gave a brief acknowledgment or filler (< 6 words, e.g. "Let me think"),
          // do NOT interrupt immediately. Give them a 15s thinking buffer before offering encouragement.
          if (userCommittedWordsThisQuestion < 6 && nudgeCountThisQuestion === 0) {
            log.info(`Candidate paused after brief utterance (${userCommittedWordsThisQuestion} words) on Q${currentQuestionIndex + 1} — granting 15s thinking buffer`);
            startSilenceGapTimer(15_000);
            return;
          }

          log.info(`Silence gap (${ANSWER_DONE_SILENCE_MS}ms post-speech): considering user answer complete on Q${currentQuestionIndex + 1}`);
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
                      ? `[SYSTEM] 受访者已作答完毕并停顿。请以温和、富有参与感的态度简短回应并自然提出跟进问题，或在讨论充分后静默调用工具切换到下一题（严禁在发言中输出任何函数名或括号）。注意：绝不要替受访者讲解或给出标准答案；若受访者刚才是在询问准备发言，只需鼓励对方继续作答。`
                      : `[SYSTEM] The participant has finished speaking and paused. Respond briefly (1-2 sentences) and probe deeper with a relevant follow-up, or transition to the next theme using silent tool calling. CRITICAL: Maintain your role as the interviewer. NEVER explain the concept, solve the question, or provide the answer yourself. NEVER speak or write tool names or bracket syntax like [signal_question_change(...)] in spoken words or text. If the candidate was asking for permission or expressing readiness to speak (e.g. "Can I rip it in?"), simply say "Go right ahead, the floor is yours!" and wait for their response.`,
                  },
                ],
              },
            })
          );
          requestAssistantResponse("silence gap - answer done");
          return;
        }

        // 3. Candidate quiet thinking timeout (12s of silence with no speech):
        // Never interrupt or nudge while candidate is actively typing code in the editor!
        const isActivelyCoding = isCodingOrWhiteboard && (Date.now() - lastCodeEditedAt < 45_000);
        if (!userSpokeThisTurn && !isActivelyCoding && currentQuestionIndex < sortedQuestions.length) {
          nudgeCountThisQuestion++;
          log.info(`Candidate quiet thinking timeout (12s, nudge #${nudgeCountThisQuestion}) on Q${currentQuestionIndex + 1} (firstQuestionAsked=${firstQuestionAsked}) — offering gentle check-in`);
          let promptText = "";

          if (!firstQuestionAsked) {
            // Quiet during opening audio confirmation
            if (nudgeCountThisQuestion === 1) {
              promptText = isZh
                ? `[SYSTEM] 您刚才询问了候选人能否听清声音（"能听到我说话吗？"），对方安静了12秒未回答。请温和礼貌地再次确认一下：“哈喽，请问能听到我的声音吗？如果可以的话请回答一下，我们马上开始面试。” 仅说这一句，不要重复长篇开场白。`
                : `[SYSTEM] You asked the candidate if they can hear you loud and clear, and they have remained silent for 12 seconds. Gently check in: "Hey there! Just checking in to see if you can hear me loud and clear? Whenever you're ready, let me know so we can jump into our first topic." Say ONLY this single gentle sentence.`;
            } else {
              promptText = isZh
                ? `[SYSTEM] 候选人长时间未回应语音确认。请提醒：“暂时没有收到您的声音，请检查一下麦克风是否已取消静音并正常连接。准备好随时告诉我！”`
                : `[SYSTEM] The candidate has still not responded to your audio check. Warmly remind them: "I'm not picking up any audio from your microphone yet. Please check that your mic is unmuted and working, or say hello whenever you're ready!"`;
            }
          } else {
            // Quiet during technical question
            if (nudgeCountThisQuestion === 1) {
              promptText = isZh
                ? `[SYSTEM] 受访者在听到题目后安静思考了12秒未作答。请以温和亲切的同行语气问候一句：'完全不用着急，放轻松！你可以花时间思考，如果有想法也可以直接边想边聊；需要我澄清题意吗？' 仅说这一句话，温和提示对方，绝不要给出答案或催促。`
                : `[SYSTEM] The candidate has been quietly thinking for 12 seconds without answering. Prompt them warmly so the interview does not stay silent: 'Take your time! Feel free to think out loud, or let me know if you'd like me to clarify anything about the question.' Say ONLY this single sentence to check in. Do NOT give the answer or rush them.`;
            } else if (nudgeCountThisQuestion === 2) {
              promptText = isZh
                ? `[SYSTEM] 受访者已继续安静思考了24秒。请温和提示：'您还在吗？完全不用着急，按你的节奏来。如果想先跳过这道题或者先聊聊别的思路，随时告诉我！'`
                : `[SYSTEM] The candidate has continued thinking quietly for 24 seconds. Check in gently: 'Are you still with me? Take your time, or if you'd like to skip this question or explore a different angle, just let me know!'`;
            } else if (nudgeCountThisQuestion === 3) {
              promptText = isZh
                ? `[SYSTEM] 受访者已长时间安静未说话（超过36秒）。请做简短语音确认：'检查一下您的语音连接是否正常，能听到我说话吗？如果准备好了随时告诉我，或者我们也可以先看下一道题。'`
                : `[SYSTEM] The candidate has remained silent for over 36 seconds. Prompt them warmly to confirm they are still there and their audio is working: 'Just checking in to make sure you can still hear me and your audio is working. Whenever you're ready, let me know, or we can move forward to the next question.'`;
            } else {
              log.info(`Candidate quiet timeout: already nudged ${nudgeCountThisQuestion} times on Q${currentQuestionIndex + 1} — backing off for 60s to avoid repetition`);
              startSilenceGapTimer(60_000);
              return;
            }
          }

          oaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: promptText,
                  },
                ],
              },
            })
          );
          requestAssistantResponse("silence gap - gentle checkin");
          return;
        } else if (isActivelyCoding) {
          startSilenceGapTimer(INITIAL_THINKING_SILENCE_MS);
          return;
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
        if (!text || !text.trim()) {
          send({ type: "asr", data: { results: [{ text: "" }] } });
          return;
        }
        const isEchoWindow = modelIsSpeaking || (Date.now() - lastAssistantAudioEndedAt < 2500);
        if (isEchoWindow) {
          const recentAssistant = [
            outputTranscriptBuffer,
            ...conversationHistory.slice(-2).filter((m) => m.role === "assistant").map((m) => m.text),
          ].filter(Boolean);
          const echoCheck = stripAssistantEcho(text, recentAssistant);
          if (echoCheck.isFullEcho) {
            send({ type: "asr", data: { results: [{ text: "" }] } });
            return;
          }
          const cleaned = echoCheck.cleanedText || text;
          send({ type: "asr", data: { results: [{ text: cleaned }] } });
          return;
        }
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
        if (!delta) return;
        if (!hasRealUserSpeech()) {
          return;
        }
        if (!tryAcceptFreshAsrText(delta, "Whisper delta")) return;
        inputTranscriptBuffer += delta;
        if (isWhisperHallucination(inputTranscriptBuffer, ctx.language)) {
          log.debug(`Interim hallucination suppressed: ${JSON.stringify(inputTranscriptBuffer)}`);
          inputTranscriptBuffer = "";
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
        if (!transcript) return;

        const isEchoWindow = modelIsSpeaking || (Date.now() - lastAssistantAudioEndedAt < 2500);
        if (isEchoWindow) {
          const recentAssistant = [
            outputTranscriptBuffer,
            ...conversationHistory.slice(-2).filter((m) => m.role === "assistant").map((m) => m.text),
          ].filter(Boolean);

          const echoCheck = stripAssistantEcho(transcript, recentAssistant);
          if (echoCheck.isFullEcho || !echoCheck.cleanedText) {
            log.info(`ASR dropped (echo of assistant): ${JSON.stringify(transcript)}`);
            inputTranscriptBuffer = "";
            return;
          }
          transcript = echoCheck.cleanedText;

          if (isEchoOfAssistant(transcript)) {
            log.debug(`ASR dropped (echo of assistant): ${JSON.stringify(transcript)}`);
            inputTranscriptBuffer = "";
            return;
          }
        }

        if (!hasRealUserSpeech()) {
          log.info(`ASR dropped (no genuine vocal energy: dur=${lastValidSpeechSegmentDuration}ms, peak=${lastValidSpeechSegmentPeakRms}): ${JSON.stringify(transcript)}`);
          inputTranscriptBuffer = "";
          return;
        }

        if (isWhisperHallucination(transcript, ctx.language)) {
          log.info(`ASR dropped (hallucination): ${JSON.stringify(transcript)}`);
          inputTranscriptBuffer = "";
          return;
        }

        if (!tryAcceptFreshAsrText(transcript, "Whisper completion")) return;

        log.info(`ASR completed: ${JSON.stringify(transcript)}`);
        inputTranscriptBuffer = mergeAsrText(inputTranscriptBuffer, transcript);
        noteTranscriptUpdate();
        if (pendingAsrUpdate) clearTimeout(pendingAsrUpdate);
        pendingAsrUpdate = null;
        emitInterimUserTranscript(inputTranscriptBuffer, true);

        // If user has stopped speaking, check for verbal completion or natural thinking silence
        if (!vadSpeechActive && !speechTranscriptCommitted) {
          const isDone = isAnswerDoneSignal(transcript) || isCodingDoneSignal(transcript) || isAnswerDoneSignal(inputTranscriptBuffer);
          const isBrief = isAudioConfirmationOrGreeting(inputTranscriptBuffer || transcript);
          if (isDone) {
            log.info(`Verbal completion detected in Whisper completion: "${transcript}" — finalizing immediately`);
            scheduleSpeechFinalize("ASR completion - verbal completion", 150);
          } else if (isBrief) {
            log.info(`Brief greeting/audio check detected in Whisper completion: "${transcript}" — finalizing promptly (1800ms)`);
            scheduleSpeechFinalize("ASR completion - brief greeting", 1800);
          } else {
            const msSinceStop = lastVadSpeechEnd ? Date.now() - lastVadSpeechEnd : 0;
            const isIncomplete = hasTrailingIncompleteThought(inputTranscriptBuffer || transcript);
            const neededSilence = isIncomplete ? 10_000 : ANSWER_DONE_SILENCE_MS;
            const finalizeDelay = Math.max(2000, neededSilence - msSinceStop);
            log.debug(`ASR completion without done signal — waiting for natural silence gap (${finalizeDelay}ms remaining)`);
            scheduleSpeechFinalize("ASR completion - natural silence", finalizeDelay);
          }
        } else {
          scheduleInputFlush();
        }
      }

      let vadStuckWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

      function clearVadWatchdogTimer() {
        if (vadStuckWatchdogTimer) {
          clearTimeout(vadStuckWatchdogTimer);
          vadStuckWatchdogTimer = null;
        }
      }

      function handleSpeechStartedEvent() {
        log.debug("VAD: user speech started");
        speechStopForwardGraceUntil = 0;

        // If the assistant is actively speaking or generating a response, NEVER allow raw
        // server VAD to blindly cancel or interrupt the assistant!
        // Microphone ambient noise, mic turn-on pops, or laptop speaker acoustic bleed
        // will trigger server VAD false-positives and instantly kill the AI's greeting/speech.
        // True candidate barge-in is handled rigorously by shouldAllowTtsBargeIn in the PCM loop.
        if (modelIsSpeaking || responseAudioStarted || responseInFlight) {
          log.debug("VAD: user speech started ignored during active assistant response (deferring to PCM barge-in)");
          return;
        }

        clearSilenceGapTimer();
        if (pendingInputFlush) {
          clearTimeout(pendingInputFlush);
          pendingInputFlush = null;
        }

        queuedAssistantResponse = null;
        cancelOngoingResponse();
        clearSpeechFinalizeTimer();
        vadSpeechActive = true;
        trailingConjunctionBuffered = false;
        lastTranscriptUpdateAt = 0;
        if (speechTranscriptCommitted) {
          speechTranscriptCommitted = false;
          volcAsrAccumulator = "";
          inputTranscriptBuffer = "";
        }
        send({ type: "interrupt" });

        // Safety watchdog: if OpenAI VAD never fires speech_stopped (ambient noise / room tone),
        // auto-recover after 6s of no genuine speech energy
        clearVadWatchdogTimer();
        vadStuckWatchdogTimer = setTimeout(() => {
          vadStuckWatchdogTimer = null;
          if (
            vadSpeechActive &&
            !hasRealUserSpeech() &&
            (Date.now() - lastTranscriptUpdateAt > 3500 || lastTranscriptUpdateAt === 0)
          ) {
            log.warn("VAD watchdog: user speech started active for 6s without genuine speech energy — resetting vadSpeechActive");
            vadSpeechActive = false;
            startSilenceGapTimer(INITIAL_THINKING_SILENCE_MS);
          }
        }, 6000);

        // Safety fallback timer: ensure silence check runs even if speech_stopped event is dropped
        silenceGapTimer = setTimeout(() => {
          silenceGapTimer = null;
          if (vadSpeechActive && !hasRealUserSpeech()) {
            log.warn("Safety watchdog: speech_stopped never received — forcing silence check");
            vadSpeechActive = false;
          }
          handleSilenceGapTimeout();
        }, 15_000);
      }

      function handleSpeechStoppedEvent() {
        clearVadWatchdogTimer();
        vadSpeechActive = false;
        lastVadSpeechEnd = Date.now();
        speechStopForwardGraceUntil = lastVadSpeechEnd + SPEECH_STOP_FORWARD_GRACE_MS;
        log.debug("VAD: user speech stopped");
        if (modelIsSpeaking || responseAudioStarted || responseInFlight) {
          return;
        }
        send({ type: "processing_start" });

        const pendingText = bestAvailableTranscript() || inputTranscriptBuffer || volcAsrAccumulator || "";
        const isDone = isAnswerDoneSignal(pendingText) || isCodingDoneSignal(pendingText);
        const isIncomplete = hasTrailingIncompleteThought(pendingText);
        const isBrief = isAudioConfirmationOrGreeting(pendingText);

        if (!speechTranscriptCommitted && pendingText) {
          if (isDone) {
            log.info(`Verbal completion detected at speech stop ("${pendingText}") — scheduling immediate finalize`);
            scheduleSpeechFinalize("speech stop (verbal completion)", 150);
          } else if (isBrief) {
            log.info(`Brief greeting/audio check detected at speech stop ("${pendingText}") — scheduling prompt finalize (1800ms)`);
            scheduleSpeechFinalize("speech stop (brief greeting)", 1800);
          } else {
            const delay = isIncomplete ? 10_000 : ANSWER_DONE_SILENCE_MS;
            scheduleSpeechFinalize("speech stop (natural silence)", delay);
          }
        }

        const silenceDelay = isDone ? 150 : (isBrief ? 1800 : (isIncomplete ? 10_000 : ANSWER_DONE_SILENCE_MS));
        startSilenceGapTimer(silenceDelay);
      }

      function flushPendingUserTurnBeforeAssistant() {
        if (!speechTranscriptCommitted && bestAvailableTranscript()) {
          const pendingUserText = bestAvailableTranscript();
          if (isWhisperHallucination(pendingUserText, ctx.language) || isEchoOfAssistant(pendingUserText)) {
            log.info(`Dropped hallucination/echo before assistant: ${JSON.stringify(pendingUserText)}`);
            inputTranscriptBuffer = "";
            volcAsrAccumulator = "";
            return;
          }
          volcAsrPreFlushed = true;
          log.info(`ASR pre-flush: ${JSON.stringify(pendingUserText)}`);
          finalizeUserTurn("response pre-flush", false);
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
          transcription: {
            model: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
            language: lang === "zh" ? "zh" : "en",
            prompt: lang === "zh"
              ? "技术面试交流：软件工程、架构设计、算法、代码实现与系统分析。"
              : "Technical interview discussion covering software engineering, React, JavaScript, TypeScript, frontend, backend, APIs, system design, data structures, algorithms.",
          },
          turn_detection: {
            type: "server_vad" as const,
            threshold: 0.80,
            prefix_padding_ms: 200,
            silence_duration_ms: 800,
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
        const remainingPlaybackMs = Math.max(0, ttsPlaybackEndsAt - Date.now());
        if (remainingPlaybackMs > 100 && !reason.includes("timeout") && reason !== "relay already closed") {
          log.info(`Deferring interview_complete by ${remainingPlaybackMs + 800}ms until farewell audio playback finishes`);
          if (interviewCompleteTimer) {
            clearTimeout(interviewCompleteTimer);
          }
          interviewCompleteTimer = setTimeout(() => {
            if (pendingInterviewComplete) {
              markInterviewComplete(reason);
            }
          }, remainingPlaybackMs + 800);
          return;
        }
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
          try { oaiWs.ping(); } catch { }
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
                    for (const t of pendingTtsText) send({ type: "tts_text", data: { text: t, delta: true } });
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
                  const cleanedDelta = msg.delta.replace(/\[(?:call\s+)?[a-zA-Z0-9_]+(?:\(.*?\))?\]/gi, "");
                  if (cleanedDelta) {
                    if (responseAudioStarted) {
                      send({ type: "tts_text", data: { text: cleanedDelta, delta: true } });
                    } else {
                      pendingTtsText.push(cleanedDelta);
                    }
                  }
                }
                break;
              }

              // ── Function call arguments complete ──
              case "response.function_call_arguments.done": {
                if (msg.name === "signal_question_change") {
                  let args: { questionIndex?: number; userRequested?: boolean } = {};
                  try { args = JSON.parse(msg.arguments || "{}"); } catch { /* ignore */ }
                  let newIdx = args.questionIndex ?? (currentQuestionIndex + 1);
                  const userRequested = args.userRequested === true;

                  // Auto-correct when model passes current index intending to advance (or candidate requested to advance)
                  if (newIdx === currentQuestionIndex) {
                    log.info(`Auto-correcting signal_question_change from current index ${newIdx} to next index ${currentQuestionIndex + 1}`);
                    newIdx = currentQuestionIndex + 1;
                  }

                  log.info(`OpenAI called signal_question_change → Q${newIdx + 1}${userRequested ? " (user requested)" : ""}`);

                  // Disallow backward question progression unless the candidate explicitly requested to revisit a previous question.
                  if (newIdx < currentQuestionIndex && !userRequested) {
                    log.warn(`Blocked automatic backward question transition from Q${currentQuestionIndex + 1} to Q${newIdx + 1}`);
                    pendingFunctionCalls.push({
                      callId: msg.call_id,
                      name: msg.name,
                      args: `Automatic backward transitions are not permitted. Continue forward on question ${currentQuestionIndex + 1} or advance to question ${currentQuestionIndex + 2}.`,
                    });
                    break;
                  }

                  // Disallow automatic forward advancement only if candidate has not actually spoken any substantive words yet
                  if (newIdx > currentQuestionIndex && !userRequested && userCommittedWordsThisQuestion === 0 && !hasRealUserSpeech()) {
                    log.warn(`Blocked premature automatic question advance from Q${currentQuestionIndex + 1} to Q${newIdx + 1}: candidate has not spoken yet`);
                    pendingFunctionCalls.push({
                      callId: msg.call_id,
                      name: msg.name,
                      args: `The candidate has not provided an answer to question ${currentQuestionIndex + 1} yet. Stay on question ${currentQuestionIndex + 1} and allow the candidate time to answer or ask if they need clarification. Do NOT advance yet.`,
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
                    nudgeCountThisQuestion = 0;
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
                outputTranscriptBuffer = "";
                modelIsSpeaking = false;
                lastAssistantAudioEndedAt = Math.max(Date.now(), ttsPlaybackEndsAt);
                const inferredFarewell =
                  !pendingInterviewComplete &&
                  !!capturedModelText &&
                  looksLikeFarewell(capturedModelText, isZh);

                if (inferredFarewell) {
                  interviewDone = true;
                  pendingInterviewComplete = true;
                  log.warn(`Inferred interview completion from farewell text: "${capturedModelText.slice(0, 60)}"`);
                }
                const completedFarewellTurn = (pendingInterviewComplete || inferredFarewell) && hadTts && responseTtsBytes > 0;

                if (hadTts && responseTtsBytes > 0) {
                  ttsPlaybackEndsAt = Math.max(ttsPlaybackEndsAt, Date.now() + 500);
                  // Flush any pending user text BEFORE committing agent text
                  // so the transcript order matches the conversation order.
                  flushPendingUserTurnBeforeAssistant();
                  if (inputTranscriptBuffer) {
                    flushUserInput();
                  }
                  if (capturedModelText) {
                    const textToolMatch = capturedModelText.match(/\[(?:call\s+)?signal_question_change(?:\(questionIndex=(\d+)\))?\]/i);
                    if (textToolMatch && pendingFunctionCalls.length === 0) {
                      const parsedIdx = textToolMatch[1] !== undefined ? parseInt(textToolMatch[1], 10) : currentQuestionIndex + 1;
                      log.warn(`Model emitted signal_question_change as text instead of tool call (idx=${parsedIdx}) — auto-advancing question`);
                      if (parsedIdx >= sortedQuestions.length) {
                        interviewDone = true;
                        pendingInterviewComplete = true;
                      } else if (parsedIdx >= 0 && parsedIdx !== currentQuestionIndex) {
                        currentQuestionIndex = parsedIdx;
                        send({
                          type: "question_change",
                          questionIndex: currentQuestionIndex,
                          totalQuestions: sortedQuestions.length,
                          auto: true,
                        });
                      }
                    }

                    const sanitizedModelText = capturedModelText
                      .replace(/\[(?:call\s+)?signal_question_change(?:\(.*?\))?\]/gi, "")
                      .trim();
                    log.info(`TTS done (${responseTtsBytes}B sent): ${JSON.stringify(sanitizedModelText)}`);
                    pushHistory("assistant", sanitizedModelText);
                    send({ type: "tts_ended", text: sanitizedModelText });
                    send({ type: "chat", data: { text: sanitizedModelText } });
                  } else {
                    send({ type: "tts_ended" });
                  }
                  userSpokeThisTurn = false;
                  inputTranscriptBuffer = "";
                  volcAsrAccumulator = "";
                  speechTranscriptCommitted = false;
                  vadSpeechActive = false;
                  userSpeechGateOpen = false;
                  if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
                    oaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
                  }
                  send({ type: "asr", data: { results: [{ text: "" }] } });
                  send({ type: "asr_ended", text: "" });
                  const remainingPlaybackMs = Math.max(0, ttsPlaybackEndsAt - Date.now());
                  const thinkingSilenceDelayMs = remainingPlaybackMs + INITIAL_THINKING_SILENCE_MS;
                  startSilenceGapTimer(thinkingSilenceDelayMs);
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
                    const remainingPlaybackMs = Math.max(0, ttsPlaybackEndsAt - Date.now());
                  const thinkingSilenceDelayMs = remainingPlaybackMs + INITIAL_THINKING_SILENCE_MS;
                  startSilenceGapTimer(thinkingSilenceDelayMs);
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
                  // Only request follow-up speech if the assistant did not already deliver spoken TTS in this response
                  if (!hadTts) {
                    requestAssistantResponse("function call follow-up");
                  }
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
          if (fiveMinuteWarningTimer) { clearTimeout(fiveMinuteWarningTimer); fiveMinuteWarningTimer = null; }

          if (inputTranscriptBuffer) {
            pushHistory("user", inputTranscriptBuffer);
          }
          if (outputTranscriptBuffer) {
            pushHistory("assistant", outputTranscriptBuffer);
            outputTranscriptBuffer = "";
          }
          modelIsSpeaking = false;
          responseInFlight = false;
          responseAudioStarted = false;
          responseAudioStartedAt = 0;
          pendingTtsText = [];
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
            modelIsSpeaking = false;
            responseInFlight = false;
            responseAudioStarted = false;
            responseAudioStartedAt = 0;
            pendingTtsText = [];
            reconnecting = false;
            send({ type: "session_reconnected" });
            startSilenceGapTimer(INITIAL_THINKING_SILENCE_MS);

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
        scheduleFiveMinuteWarning();
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
          const firstQText = sortedQuestions[0]?.text || "";
          const greeting = isZh
            ? `受访者刚刚进入面试房间。请打个招呼开启面试："您好！感谢今天参加我们的技术面试。能听清我的声音吗？" 等候选人确认听清后，自然切入关于${ctx.title}的第一个技术主题并提出问题："${firstQText}"。切勿在提问前说"话筒交给你"或沉默等待。`
            : `The candidate has just joined the interview. Open with this exact warm greeting: "Hey! Thanks for taking the time to interview today. Can you hear me loud and clear?" (Use the word "interview", NOT "chat"). Wait for their audio confirmation. Once they confirm, seamlessly introduce ${ctx.title} and ask the first question: "${firstQText}". DO NOT say "the floor is yours" or wait in silence before asking this question!`;
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
              log.info("Interview ending (wrap up) — dispatching farewell");
              if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
                const farewellPrompt = isZh
                  ? `[SYSTEM] 候选人已完成面试或提出了结束/交卷请求。请以温暖、亲切的考官语气向候选人表达感谢并道别（例如：“感谢你今天的参与和精彩回答，今天的面试就到这里了，祝你一切顺利，再见！”），说出这句告别语即可。`
                  : `[SYSTEM] The candidate has finished or requested to wrap up the interview. Warmly thank them for their time and thoughtful answers, and deliver a natural, polite farewell (e.g., "Thank you so much for your time today! That wraps up our interview. Have a great day and best of luck!"). Deliver this spoken farewell now.`;
                oaiWs.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "system",
                      content: [{ type: "input_text", text: farewellPrompt }],
                    },
                  })
                );
                requestAssistantResponse("interview wrap-up farewell");
              }
              interviewCompleteTimer = setTimeout(() => {
                if (pendingInterviewComplete) {
                  markInterviewComplete("timeout fallback");
                }
              }, 12_000);
            }
            return;
          }
          const dir = targetIdx > currentQuestionIndex ? "→" : "←";
          currentQuestionIndex = targetIdx;
          questionEnteredAt = Date.now();
          userCommittedWordsThisQuestion = 0;
          userSpokeThisTurn = false;
          nudgeCountThisQuestion = 0;
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

        if (isCandidateWrapUpRequest(userText)) {
          log.info(`Fast-path WRAP-UP transition from user: "${userText}"`);
          requestTransition(sortedQuestions.length, "End Interview", "user_request");
          return true;
        }

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

          if (msg.type === "candidate_turn_done") {
            const reason = (msg.reason as string) || "unknown";
            const clientText = typeof msg.text === "string" ? msg.text.trim() : "";
            log.info(`[relay] Received candidate_turn_done (reason: ${reason}, text: ${clientText ? JSON.stringify(clientText) : "none"})`);
            const nowMs = Date.now();
            if (userSpeechGateOpen) {
              lastValidSpeechSegmentDuration = lastVoiceEnergyTime - userSpeechStartMs;
              lastValidSpeechSegmentPeakRms = userSpeechPeakRmsThisSegment;
              lastValidSpeechSegmentEndedAt = nowMs;
              userSpeechGateOpen = false;
              audioPreRoll = [];
            }
            clearSilenceGapTimer();

            // 1. If verified client text was provided (e.g. from Chrome Web Speech API)
            if (clientText) {
              const isEchoWindow = modelIsSpeaking || (Date.now() - lastAssistantAudioEndedAt < 2500);
              let effectiveClientText = clientText;
              if (isEchoWindow) {
                const recentAssistant = [
                  outputTranscriptBuffer,
                  ...conversationHistory.slice(-2).filter((m) => m.role === "assistant").map((m) => m.text),
                ].filter(Boolean);

                const echoCheck = stripAssistantEcho(clientText, recentAssistant);
                if (echoCheck.isFullEcho || !echoCheck.cleanedText) {
                  log.info(`Ignored candidate_turn_done clientText (full echo): ${JSON.stringify(clientText)}`);
                  return;
                }
                effectiveClientText = echoCheck.cleanedText;

                if (isWhisperHallucination(effectiveClientText, ctx.language) || isEchoOfAssistant(effectiveClientText)) {
                  log.info(`Ignored candidate_turn_done clientText (hallucination or echo): ${JSON.stringify(effectiveClientText)}`);
                  return;
                }
              }

              // Clear any pending audio buffer in OpenAI to avoid processing background noise
              if (oaiWs?.readyState === WebSocket.OPEN) {
                try {
                  oaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
                } catch {
                  // ignore
                }
              }

              lastUserInput = Date.now();
              queuedAssistantResponse = null;
              userSpokeThisTurn = true;
              speechTranscriptCommitted = true;
              lastCommittedUserTranscript = effectiveClientText;
              lastCommittedUserTranscriptAt = Date.now();
              pushHistory("user", effectiveClientText);
              armStaleAsrGuard(effectiveClientText);
              lastValidSpeechSegmentDuration = 0;
              lastValidSpeechSegmentPeakRms = 0;
              lastValidSpeechSegmentEndedAt = 0;

              // Broadcast final ASR to client so transcript & state are synchronized
              send({ type: "asr_ended", text: effectiveClientText });

              if (tryHandleExplicitUserNavigation(effectiveClientText)) {
                return;
              }

              if (isRepeatOrClarificationRequest(effectiveClientText)) {
                log.info(`Candidate requested question repeat/clarification: "${effectiveClientText}"`);
                if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
                  oaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "system",
                      content: [{
                        type: "input_text",
                        text: isZh
                          ? `[SYSTEM] 候选人刚才请求重复刚才的问题（"${effectiveClientText}"）。请以温和清晰的口吻重新阐述或举例说明你刚才提出的问题或探讨点。切勿跳回开场白或第一题。`
                          : `[SYSTEM] The candidate asked you to repeat or clarify what you just asked ("${effectiveClientText}"). Warmly and clearly repeat or rephrase the question or topic you just asked about in simple terms. Do NOT revert back to question 1 or previous introductory topics.`,
                      }],
                    },
                  }));
                  requestAssistantResponse("candidate requested question repetition");
                }
                return;
              }

              if (oaiWs?.readyState === WebSocket.OPEN) {
                cancelOngoingResponse();
                if (!firstQuestionAsked) {
                  firstQuestionAsked = true;
                  const firstQText = sortedQuestions[0]?.text || "";
                  oaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "system",
                      content: [{
                        type: "input_text",
                        text: isZh
                          ? `[SYSTEM] 候选人已回应（"${effectiveClientText}"）。绝对不要重复问候，也不要再次询问能否听清！请热情确认对方声音清晰（如："太好了，声音非常清晰！"），并立即正式介绍${ctx.title}并提出第一道题目："${firstQText}"。切勿在提问前说"话筒交给你"或沉默等待。`
                          : `[SYSTEM] The candidate has responded ("${effectiveClientText}"). CRITICAL: DO NOT repeat the opening greeting and DO NOT ask "can you hear me" again! Confirm enthusiastically that you can hear them (e.g., "Awesome, loud and clear!"), seamlessly introduce ${ctx.title}, and immediately ask Question 1: "${firstQText}". DO NOT say "the floor is yours" before asking the question!`,
                      }],
                    },
                  }));
                }
                oaiWs.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: effectiveClientText }],
                  },
                }));
                requestAssistantResponse(`candidate turn (${reason})`);
              }
              return;
            }

            // 2. Fallback: if server ASR has uncommitted text
            if (!speechTranscriptCommitted && bestAvailableTranscript()) {
              log.info("candidate_turn_done: committing pending user transcript");
              finalizeUserTurn("candidate_turn_done", true);
              return;
            }

            // 3. Candidate muted without clientText.
            // ONLY trigger an AI response if the user actually spoke substantive words during this question!
            // Never trigger an AI turn if the candidate simply muted their mic while silent or listening!
            if (!responseInFlight && !modelIsSpeaking && userSpokeThisTurn && userCommittedWordsThisQuestion >= 3) {
              userSpokeThisTurn = false;
              if (oaiWs?.readyState === WebSocket.OPEN) {
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
                            ? `[SYSTEM] 受访者已作答完毕并静音。请简短回应并自然提出跟进问题，或在讨论充分后调用 signal_question_change 切换到下一题。注意：绝不要替受访者讲解或给出标准答案。`
                            : `[SYSTEM] The participant has finished answering and muted. Respond briefly (1-2 sentences) and either ask a concise follow-up or transition to the next theme via signal_question_change. CRITICAL: Maintain your role as the interviewer. NEVER explain the concept, solve the question, or provide the answer yourself.`,
                        },
                      ],
                    },
                  })
                );
                requestAssistantResponse("candidate_turn_done");
              }
            } else {
              log.info(`candidate_turn_done (${reason}): candidate muted without speaking substantive answer — remaining silent`);
            }
            return;
          }

          if (msg.type === "code_execution_result") {
            log.info(`[relay] Received code_execution_result (success: ${msg.success}, duration: ${msg.executionTimeMs}ms)`);
            latestCode = (msg.code as string) || latestCode;
            latestCodeLanguage = (msg.language as string) || latestCodeLanguage;
            if (oaiWs?.readyState === WebSocket.OPEN) {
              const logsText = Array.isArray(msg.logs) && msg.logs.length > 0
                ? msg.logs.join("\n")
                : "(No console logs)";
              const outputText = msg.error
                ? `Runtime Error:\n${msg.error}`
                : `Execution Output / Return Value:\n${msg.resultFormatted || "(undefined)"}`;

              const codeExecutionReport = `[CODE_EXECUTION_RESULT] The participant just executed their code in the browser (${msg.language || "javascript"}).
Execution Status: ${msg.success ? "SUCCESS" : "ERROR"} (${msg.executionTimeMs || 0}ms)

Code:
\`\`\`${msg.language || "javascript"}
${msg.code || latestCode}
\`\`\`

Console Logs:
${logsText}

${outputText}

[INTERVIEWER INSTRUCTION]:
The candidate just ran their code and can see these results on their screen.
Conduct a realistic oral code review:
1. Acknowledge what the code printed or returned (e.g. "I see your filter returned [2, 4]").
2. If there's an error, ask them how they'd debug or resolve it.
3. If it succeeded, ask them about edge cases (e.g. empty array, negative numbers) or time/space complexity (O(n)).
4. Once satisfied, smoothly transition to the next question using signal_question_change.
Remember: Keep it conversational and concise (1-2 sentences). Do NOT read back raw stack traces.`;

              oaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{
                    type: "input_text",
                    text: codeExecutionReport,
                  }],
                },
              }));
              requestAssistantResponse("code_execution_result");
            }
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

            let sumSq = 0;
            const sampleCount = Math.floor(rawPcm.length / 2);
            for (let i = 0; i < sampleCount; i++) {
              const val = rawPcm.readInt16LE(i * 2);
              sumSq += val * val;
            }
            const rms = Math.sqrt(sumSq / (sampleCount || 1));

            const inEchoCooldown = (nowMs - lastTtsAudioTime) < TTS_ECHO_COOLDOWN_MS || nowMs < ttsPlaybackEndsAt;

            const bargeInFrameEligible =
              inEchoCooldown &&
              (modelIsSpeaking
                ? responseAudioStarted &&
                  responseAudioStartedAt > 0 &&
                  nowMs - responseAudioStartedAt >= DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS &&
                  responseTtsBytes >= DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES
                : true) &&
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
              ttsPlaybackEndsAt = 0;
              lastTtsAudioTime = 0;
              cancelOngoingResponse();
              send({ type: "interrupt" });
            }

            const canForwardAudio = !inEchoCooldown || allowBargeInDuringTts;

            if (canForwardAudio) {
              if (!userSpeechGateOpen) {
                // Adapt ambient noise floor with an exponential moving average
                ambientNoiseFloorRms = Math.min(300, Math.max(40, ambientNoiseFloorRms * 0.98 + rms * 0.02));
              }

              const SPEECH_GATE_OPEN_RMS = Math.max(120, Math.round(ambientNoiseFloorRms * 1.5));
              const SPEECH_GATE_HOLD_RMS = Math.max(70, Math.round(ambientNoiseFloorRms * 1.1));
              const SPEECH_HANGOVER_MS = 800;
              const MAX_PRE_ROLL = 6;

              if (rms >= SPEECH_GATE_OPEN_RMS) {
                lastVoiceEnergyTime = nowMs;
                if (!userSpeechGateOpen) {
                  userSpeechGateOpen = true;
                  userSpeechStartMs = nowMs;
                  userSpeechPeakRmsThisSegment = rms;
                  clearSpeechFinalizeTimer();

                  // Flush pre-roll buffer so the leading consonant/syllable is never lost
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
              }

              if (userSpeechGateOpen) {
                userSpeechPeakRmsThisSegment = Math.max(userSpeechPeakRmsThisSegment, rms);
                if (rms >= SPEECH_GATE_HOLD_RMS) {
                  lastVoiceEnergyTime = nowMs;
                }

                // Track user activity when vocal energy is sustained, without cancelling quiet thinking check-in timers
                if (userSpeechPeakRmsThisSegment >= 120 && nowMs - userSpeechStartMs >= 150) {
                  lastUserInput = nowMs;
                }

                lastAudioSentToOai = Date.now();
                oaiWs.send(JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: pcm24k.toString("base64"),
                }));
                sendAudioToVolc(rawPcm);

                // Close gate after silence
                const shouldCloseHangover = nowMs - lastVoiceEnergyTime >= SPEECH_HANGOVER_MS;
                if (shouldCloseHangover) {
                  userSpeechGateOpen = false;
                  const segDuration = nowMs - userSpeechStartMs;
                  lastVoiceEnergyTime = 0;

                  // Only clear OpenAI buffer on micro-spikes (< 80ms and < 100 RMS)
                  if (segDuration < 80 && userSpeechPeakRmsThisSegment < 100) {
                    log.debug(`Cleared OpenAI audio buffer after micro click (peak=${Math.round(userSpeechPeakRmsThisSegment)}, dur=${segDuration}ms)`);
                    oaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
                    userSpeechPeakRmsThisSegment = 0;
                    audioPreRoll = [];
                  } else {
                    lastValidSpeechSegmentDuration = segDuration;
                    lastValidSpeechSegmentPeakRms = userSpeechPeakRmsThisSegment;
                    lastValidSpeechSegmentEndedAt = nowMs;
                    userSpeechPeakRmsThisSegment = 0;
                    audioPreRoll = [];
                  }

                  // Ensure silence gap timer is active if candidate has not committed an answer yet
                  if (!userSpokeThisTurn && !speechTranscriptCommitted && !modelIsSpeaking && !responseInFlight && !silenceGapTimer) {
                    const remainingPlaybackMs = Math.max(0, ttsPlaybackEndsAt - Date.now());
                    const thinkingSilenceDelayMs = remainingPlaybackMs + INITIAL_THINKING_SILENCE_MS;
                    startSilenceGapTimer(thinkingSilenceDelayMs);
                  }

                  // Deliver queued proctor alert if candidate stopped speaking
                  if (pendingProctorAlert && !modelIsSpeaking && !responseInFlight && Date.now() - pendingProctorAlert.at < 20_000) {
                    deliverProctorDisruption(pendingProctorAlert.alertType, pendingProctorAlert.detail);
                  }
                }
              } else {
                // Buffer pre-roll audio while silent; do NOT send pure silence to OpenAI!
                audioPreRoll.push(pcm24k);
                if (audioPreRoll.length > MAX_PRE_ROLL) {
                  audioPreRoll.shift();
                }
              }
            } else {
              if (userSpeechGateOpen) {
                lastValidSpeechSegmentDuration = lastVoiceEnergyTime - userSpeechStartMs;
                lastValidSpeechSegmentPeakRms = userSpeechPeakRmsThisSegment;
                lastValidSpeechSegmentEndedAt = nowMs;
                userSpeechPeakRmsThisSegment = 0;
              }
              userSpeechGateOpen = false;
              audioPreRoll = [];
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
            lastCodeEditedAt = Date.now();
            if (content) {
              oaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{
                    type: "input_text", text:
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
                  content: [{ type: "output_text", text: "(Noted code update. I will conduct an oral code defense on the implementation.)" }],
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
                  content: [{ type: "output_text", text: "(Received whiteboard update.)" }],
                },
              }));
              log.info("Whiteboard image sent to OpenAI");
            }
          } else if (msg.type === "proctor_alert") {
            const alertType = (msg.alertType as string) || "";
            const detail = (msg.detail as string) || "";
            log.info(`[proctor] Anti-cheating event received: ${alertType} (${detail})`);

            const isCriticalAlert =
              alertType === "face_missing" ||
              alertType === "multiple_faces" ||
              alertType === "face_mismatch" ||
              alertType === "page_departure";

            // For critical integrity alerts (face missing, multiple faces, face mismatch, page departure),
            // immediately disrupt and smoothly warn the candidate without delay, even mid-speech.
            if (!isCriticalAlert) {
              const now = Date.now();
              const isActivelySpeaking = userSpeechGateOpen && (now - lastVoiceEnergyTime < 800) && userSpeechPeakRmsThisSegment >= 400;
              if (isActivelySpeaking) {
                log.info(`[proctor] Queued pending spoken disruption for ${alertType} (candidate is actively speaking)`);
                pendingProctorAlert = { alertType, detail, at: now };
                return;
              }
            }

            deliverProctorDisruption(alertType, detail);
          } else if (msg.type === "time_expired") {
            log.info("Interview time limit reached — triggering graceful spoken farewell");
            cancelOngoingResponse();
            interviewDone = true;
            pendingInterviewComplete = true;

            const farewellText = isZh
              ? "抱歉打扰一下，本次面试的规定时间已经到了，我们今天的交流就到这里。非常感谢您今天的参与和详尽回答！招聘团队会尽快复核面试记录并与您联系后续事宜。祝您生活愉快，再见！"
              : "Excuse me, I see our allotted time for this interview has reached its limit, so we will wrap things up here. Thank you so much for your time and thoughtful responses today! The recruiting team will review your session and be in touch soon. Have a wonderful day!";

            if (oaiWs?.readyState === WebSocket.OPEN) {
              oaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "system",
                  content: [{
                    type: "input_text",
                    text: `[SYSTEM INSTRUCTION - TIME LIMIT EXPIRED]: The interview time limit has just expired. Deliver this spoken farewell to the candidate word for word right now, and do NOT ask any further questions:\n"${farewellText}"`,
                  }],
                },
              }));
              requestAssistantResponse("time expired farewell");

              interviewCompleteTimer = setTimeout(() => {
                if (pendingInterviewComplete) {
                  markInterviewComplete("timeout farewell fallback");
                }
              }, 12_000);
            } else {
              markInterviewComplete("relay already closed");
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
