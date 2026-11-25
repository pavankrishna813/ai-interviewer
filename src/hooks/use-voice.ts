"use client";

import { createLogger } from "@/lib/logger";
import {
  buildRelayTargets,
  isRecoverableRelayErrorMessage,
  RelayConnector,
  relayDisplayName,
  resolveRelayPrimaryPreference,
} from "@/lib/voice/relay-routing";
import {
  JITTER_BUFFER_MAX_WAIT_MS,
  PLAYBACK_SAMPLE_RATE,
  shouldFlushPlaybackQueue,
} from "@/lib/voice/playback-jitter-buffer";
import { isWhisperHallucination } from "@/lib/voice/hallucination-filter";
import {
  hasTrailingIncompleteThought,
  isAnswerDoneSignal,
  isCodingDoneSignal,
  isAudioConfirmationOrGreeting,
  stripAssistantEcho,
  COMMON_ASSISTANT_UTTERANCES,
} from "@/lib/voice/turn-completion";
import { useCallback, useEffect, useRef, useState } from "react";

const log = createLogger("voice");

export interface InterviewContext {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any;
    starterCode?: { language: string; code: string } | null;
    order: number;
  }>;
}

interface UseVoiceOptions {
  interviewId: string;
  sessionId: string;
  interviewContext: InterviewContext;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onAIResponse?: (text: string) => void;
  onError?: (error: string) => void;
  onQuestionChange?: (index: number, total: number) => void;
  onTtsChunk?: (pcmData: ArrayBuffer) => void;
  onInterrupt?: () => void;
}

interface VoiceState {
  isConnected: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  isTransitioning: boolean;
  transitionDirection: "next" | "previous" | null;
  isSaving: boolean;
  isInterviewComplete: boolean;
  userTranscript: string;
  aiTranscript: string;
  lastAssistantUtteranceEndedAt: number;
  audioLevel: number;
  currentQuestionIndex: number;
  totalQuestions: number;
}

interface TrackedMessage {
  role: "user" | "assistant";
  content: string;
  source?: "voice" | "chat";
}

/**
 * Voice interview hook using Volcengine S2S (Speech-to-Speech) via relay.
 *
 * Flow:
 * 1. Browser connects and sends interview context to relay
 * 2. Relay builds system prompt and connects to Volcengine
 * 3. Browser captures mic audio as 16kHz int16 PCM
 * 4. Audio sent to relay server via WebSocket (hex-encoded)
 * 5. Relay forwards to Volcengine S2S which handles ASR + LLM + TTS
 * 6. TTS audio (24kHz float32 PCM) streamed back and played via AudioContext
 * 7. Per-question transitions managed by relay with LLM summarization
 * 8. On disconnect, all messages are saved to database
 */
const HEX_LOOKUP: string[] = [];
for (let i = 0; i < 256; i++) {
  HEX_LOOKUP[i] = i.toString(16).padStart(2, "0");
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_LOOKUP[bytes[i]];
  }
  return hex;
}

/**
 * Resamples floating point input to 24kHz 16-bit PCM.
 * Uses an area-weighted box filter (anti-aliasing) when downsampling from
 * 48kHz / 44.1kHz so high-frequency harmonics do not alias into the speech spectrum.
 */
function downsampleTo24k(inputData: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 24000) {
    const pcm = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  }

  const ratio = inputSampleRate / 24000;
  const newLength = Math.max(1, Math.round(inputData.length / ratio));
  const result = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const start = i * ratio;
    const end = (i + 1) * ratio;
    const startIdx = Math.floor(start);
    const endIdx = Math.min(inputData.length, Math.ceil(end));

    let sum = 0;
    let count = 0;
    for (let j = startIdx; j < endIdx; j++) {
      const overlap = Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
      sum += inputData[j] * overlap;
      count += overlap;
    }

    const avg = count > 0 ? sum / count : (inputData[startIdx] || 0);
    const s = Math.max(-1, Math.min(1, avg));
    result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return result;
}

export function useVoice({
  sessionId,
  interviewContext,
  onTranscript,
  onAIResponse,
  onError,
  onQuestionChange,
  onTtsChunk,
  onInterrupt,
}: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>({
    isConnected: false,
    isListening: false,
    isSpeaking: false,
    isProcessing: false,
    isTransitioning: false,
    transitionDirection: null,
    isSaving: false,
    isInterviewComplete: false,
    userTranscript: "",
    aiTranscript: "",
    lastAssistantUtteranceEndedAt: 0,
    audioLevel: 0,
    currentQuestionIndex: interviewContext.startQuestionIndex ?? 0,
    totalQuestions: interviewContext.questions.length,
  });

  const relayConnectorRef = useRef<RelayConnector<Record<string, unknown>> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processorRef = useRef<any>(null);
  const playTimeRef = useRef(0);
  const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const queuedAudioChunksRef = useRef<Float32Array[]>([]);
  const queuedAudioSamplesRef = useRef(0);
  const firstQueuedAudioAtRef = useRef<number | null>(null);
  const playbackFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const isListeningRef = useRef(false);
  const trackedMessagesRef = useRef<TrackedMessage[]>([]);
  const micHoldUntilRef = useRef(0);
  const bargeInFramesRef = useRef(0);

  const BARGE_IN_RMS_THRESHOLD = 0.12;
  const BARGE_IN_FRAME_COUNT = 6;
  const lastSpokenTimeRef = useRef(0);
  const recentAiUtterancesRef = useRef<string[]>([]);
  const lastAiSpeechEndedAtRef = useRef<number>(0);
  const speechRecognitionResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSpeakerEcho = useCallback((candidateText: string): boolean => {
    if (!candidateText || !candidateText.trim()) return false;

    // Preserve valid brief candidate greetings and mic checks ("Yes, I can hear you", etc.)
    if (isAudioConfirmationOrGreeting(candidateText)) {
      return false;
    }

    const utterancesToCheck = [
      chatBufferRef.current.trim(),
      ...recentAiUtterancesRef.current,
      ...COMMON_ASSISTANT_UTTERANCES,
    ].filter(Boolean);

    // 1. Check substring of full sentence/clause (>= 20 chars)
    const normCand = candidateText.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (normCand.length >= 20) {
      for (const aiText of utterancesToCheck) {
        const normAi = aiText.toLowerCase().replace(/[^\w\s]/g, "").trim();
        if (normAi.length >= 20 && (normAi.includes(normCand) || normCand.includes(normAi))) {
          return true;
        }
      }
    }

    // 2. Exact n-gram phrase coverage from stripAssistantEcho
    const echoCheck = stripAssistantEcho(candidateText, utterancesToCheck);
    return echoCheck.isFullEcho;
  }, []);

  const onInterruptRef = useRef(onInterrupt);
  useEffect(() => { onInterruptRef.current = onInterrupt; }, [onInterrupt]);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  const lastFinalUserTranscriptRef = useRef<{ text: string; at: number } | null>(null);

  // Buffers for accumulating streaming chunks
  const asrBufferRef = useRef<string>("");
  const accumulatedSpeechRef = useRef<string>("");
  const candidateTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatBufferRef = useRef<string>("");
  const lastOnAIResponseRef = useRef<string>("");
  const currentQuestionIndexRef = useRef(
    interviewContext.startQuestionIndex ?? 0
  );
  const latestCodeUpdateRef = useRef<{ content: string; language: string } | null>(
    null
  );
  const latestWhiteboardUpdateRef = useRef<string | null>(null);

  useEffect(() => {
    currentQuestionIndexRef.current = state.currentQuestionIndex;
  }, [state.currentQuestionIndex]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitCandidateTurn = useCallback((text: string, reason: string) => {
    if (candidateTurnTimerRef.current) {
      clearTimeout(candidateTurnTimerRef.current);
      candidateTurnTimerRef.current = null;
    }
    accumulatedSpeechRef.current = "";
    asrBufferRef.current = "";
    if (!text || !text.trim()) return;

    // Suppress speaker acoustic echo
    if (isSpeakerEcho(text)) {
      log.info(`Suppressed isSpeakerEcho in commitCandidateTurn (${reason}): "${text}"`);
      return;
    }

    // Strip any interviewer question/statement echo from the candidate's turn
    const echoCheck = stripAssistantEcho(text, [
      chatBufferRef.current.trim(),
      ...recentAiUtterancesRef.current,
    ].filter(Boolean));

    if (echoCheck.isFullEcho || !echoCheck.cleanedText) {
      log.info(`Suppressed 100% assistant echo in commitCandidateTurn (${reason}): "${text}"`);
      return;
    }

    const clean = echoCheck.cleanedText.trim();
    if (!clean) return;

    const normalized = clean.replace(/\s+/g, " ").trim().toLowerCase();
    const lastFinal = lastFinalUserTranscriptRef.current;
    const isDuplicate =
      !!lastFinal &&
      lastFinal.text === normalized &&
      Date.now() - lastFinal.at < 12_000;

    if (!isDuplicate) {
      lastFinalUserTranscriptRef.current = { text: normalized, at: Date.now() };
      onTranscriptRef.current?.(clean, true);
      trackedMessagesRef.current.push({
        role: "user",
        content: clean,
      });

      if (relayConnectorRef.current?.isReady) {
        log.info(`Forwarding completed candidate answer (${reason}): "${clean}"`);
        relayConnectorRef.current.sendJson({
          type: "candidate_turn_done",
          reason,
          text: clean,
        });
      }
    }

    setState((s) => ({
      ...s,
      userTranscript: "",
      isProcessing: true,
    }));
  }, []);

  const cleanup = useCallback(() => {
    if (candidateTurnTimerRef.current) {
      clearTimeout(candidateTurnTimerRef.current);
      candidateTurnTimerRef.current = null;
    }
    accumulatedSpeechRef.current = "";
    stopListening();
    interruptPlayback();
    relayConnectorRef.current?.close();
    relayConnectorRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    setState((prev) => ({
      ...prev,
      isConnected: false,
      isListening: false,
      isSpeaking: false,
      isProcessing: false,
      isTransitioning: false,
      transitionDirection: null,
      userTranscript: "",
      aiTranscript: "",
      lastAssistantUtteranceEndedAt: 0,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearPlaybackFlushTimer = useCallback(() => {
    if (playbackFlushTimerRef.current) {
      clearTimeout(playbackFlushTimerRef.current);
      playbackFlushTimerRef.current = null;
    }
  }, []);

  const clearQueuedAudio = useCallback(() => {
    clearPlaybackFlushTimer();
    queuedAudioChunksRef.current = [];
    queuedAudioSamplesRef.current = 0;
    firstQueuedAudioAtRef.current = null;
  }, [clearPlaybackFlushTimer]);

  /** Stop all currently playing audio sources and notify recording mixer */
  const interruptPlayback = useCallback(() => {
    clearQueuedAudio();
    for (const source of audioSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    audioSourcesRef.current = [];
    playTimeRef.current = 0;
    micHoldUntilRef.current = performance.now() + 400;
    lastAiSpeechEndedAtRef.current = Date.now();
    bargeInFramesRef.current = 0;
    setState((s) => ({ ...s, isSpeaking: false }));
    onInterruptRef.current?.();

    if (speechRecognitionResumeTimerRef.current) {
      clearTimeout(speechRecognitionResumeTimerRef.current);
      speechRecognitionResumeTimerRef.current = null;
    }
    speechRecognitionResumeTimerRef.current = setTimeout(() => {
      speechRecognitionResumeTimerRef.current = null;
      if (isListeningRef.current && speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.start();
        } catch {
          // already active
        }
      }
    }, 450);
  }, [clearQueuedAudio]);

  const scheduleQueuedAudioFlush = useCallback(
    (flushQueuedAudio: (force?: boolean) => void) => {
      if (playbackFlushTimerRef.current) return;
      const firstQueuedAt = firstQueuedAudioAtRef.current;
      const delayMs =
        typeof firstQueuedAt === "number"
          ? Math.max(0, JITTER_BUFFER_MAX_WAIT_MS - (performance.now() - firstQueuedAt))
          : JITTER_BUFFER_MAX_WAIT_MS;
      playbackFlushTimerRef.current = setTimeout(() => {
        playbackFlushTimerRef.current = null;
        flushQueuedAudio(true);
      }, delayMs);
    },
    []
  );

  const flushQueuedAudio = useCallback((force = false) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    if (queuedAudioSamplesRef.current === 0) return;

    const now = ctx.currentTime;
    const bufferedAheadMs = Math.max(0, (playTimeRef.current - now) * 1000);
    if (
      !force &&
      !shouldFlushPlaybackQueue({
        queuedSamples: queuedAudioSamplesRef.current,
        bufferedAheadMs,
        firstChunkQueuedAtMs: firstQueuedAudioAtRef.current,
        nowMs: performance.now(),
        sampleRate: PLAYBACK_SAMPLE_RATE,
      })
    ) {
      scheduleQueuedAudioFlush(flushQueuedAudio);
      return;
    }

    clearPlaybackFlushTimer();

    const float32 = new Float32Array(queuedAudioSamplesRef.current);
    let offset = 0;
    for (const chunk of queuedAudioChunksRef.current) {
      float32.set(chunk, offset);
      offset += chunk.length;
    }

    queuedAudioChunksRef.current = [];
    queuedAudioSamplesRef.current = 0;
    firstQueuedAudioAtRef.current = null;

    const audioBuffer = ctx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Schedule playback sequentially
    const startAt = Math.max(now, playTimeRef.current);
    source.start(startAt);
    playTimeRef.current = startAt + audioBuffer.duration;
    micHoldUntilRef.current =
      performance.now() + Math.max(0, (playTimeRef.current - now) * 1000) + 800;
    bargeInFramesRef.current = 0;

    audioSourcesRef.current.push(source);
    setState((s) => ({
      ...s,
      isSpeaking: true,
      isProcessing: false,
    }));

    // Halt Web Speech recognition while AI speaker audio is playing to prevent speaker bleed
    if (speechRecognitionResumeTimerRef.current) {
      clearTimeout(speechRecognitionResumeTimerRef.current);
      speechRecognitionResumeTimerRef.current = null;
    }
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.abort();
      } catch {
        // noop
      }
    }
    accumulatedSpeechRef.current = "";
    if (candidateTurnTimerRef.current) {
      clearTimeout(candidateTurnTimerRef.current);
      candidateTurnTimerRef.current = null;
    }

    source.onended = () => {
      audioSourcesRef.current = audioSourcesRef.current.filter(
        (s) => s !== source
      );
      if (
        audioSourcesRef.current.length === 0 &&
        queuedAudioSamplesRef.current === 0
      ) {
        lastAiSpeechEndedAtRef.current = Date.now();
        // Hold mic shut briefly (500ms) post-playback to block trailing room echo
        micHoldUntilRef.current = performance.now() + 500;
        setState((s) => ({ ...s, isSpeaking: false }));

        if (speechRecognitionResumeTimerRef.current) {
          clearTimeout(speechRecognitionResumeTimerRef.current);
        }
        speechRecognitionResumeTimerRef.current = setTimeout(() => {
          speechRecognitionResumeTimerRef.current = null;
          if (
            isListeningRef.current &&
            audioSourcesRef.current.length === 0 &&
            speechRecognitionRef.current
          ) {
            try {
              speechRecognitionRef.current.start();
            } catch {
              // already active
            }
          }
        }, 550);
      }
    };
  }, [clearPlaybackFlushTimer, scheduleQueuedAudioFlush]);

  /** Queue incoming float32 PCM audio chunk and flush through a small jitter buffer. */
  const playAudio = useCallback(
    (pcmData: ArrayBuffer) => {
      const ctx = audioContextRef.current;
      if (!ctx) return;
      if (ctx.state === "suspended") {
        void ctx.resume();
      }

      const float32 = new Float32Array(pcmData);
      if (float32.length === 0) return;

      lastAiSpeechEndedAtRef.current = Date.now();
      if (firstQueuedAudioAtRef.current === null) {
        firstQueuedAudioAtRef.current = performance.now();
      }
      queuedAudioChunksRef.current.push(float32);
      queuedAudioSamplesRef.current += float32.length;
      flushQueuedAudio();
    },
    [flushQueuedAudio]
  );

  const replayLatestRelayContext = useCallback(
    (connector?: RelayConnector<Record<string, unknown>> | null) => {
      const client = connector ?? relayConnectorRef.current;
      if (!client) return;

      const latestCode = latestCodeUpdateRef.current;
      if (latestCode) {
        client.sendJson({
          type: "code_update",
          content: latestCode.content,
          language: latestCode.language,
        });
      }

      const latestWhiteboard = latestWhiteboardUpdateRef.current;
      if (latestWhiteboard) {
        client.sendJson({
          type: "whiteboard_update",
          imageDataUrl: latestWhiteboard,
        });
      }
    },
    []
  );

  /** Connect to the voice relay server */
  const connect = useCallback(async () => {
    try {
      // Request microphone permission
      await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create AudioContext for playback
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }
      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      // Reset tracked messages
      trackedMessagesRef.current = [];

      relayConnectorRef.current?.close();

      const targets = buildRelayTargets({
        language: interviewContext.language,
        voiceRelayUrl: process.env.NEXT_PUBLIC_VOICE_RELAY_URL,
        openAiRelayUrl: process.env.NEXT_PUBLIC_OPENAI_VOICE_RELAY_URL,
        primaryPreference: resolveRelayPrimaryPreference(
          process.env.NEXT_PUBLIC_VOICE_RELAY_PRIMARY,
        ),
        browserProtocol:
          typeof window !== "undefined" ? window.location.protocol : undefined,
        browserHost:
          typeof window !== "undefined" ? window.location.host : undefined,
      });

      const connector = new RelayConnector<Record<string, unknown>>({
        targets,
        binaryType: "arraybuffer",
        buildInitMessage: () => ({
          type: "init",
          context: {
            ...interviewContext,
            startQuestionIndex: currentQuestionIndexRef.current,
          },
        }),
        onJsonMessage: (msg) => {
          handleRelayMessage(msg);
        },
        onBinaryMessage: (data) => {
          playAudio(data);
          onTtsChunk?.(data);
        },
        onConnected: ({ target, isFailover, connector: activeConnector }) => {
          log.info(
            `${isFailover ? "Failed over to" : "Connected to"} ${relayDisplayName(
              target.kind
            )} @ ${target.url}`
          );
          if (isFailover) {
            replayLatestRelayContext(activeConnector);
          }
        },
        onFailover: ({ from, to, reason }) => {
          log.warn(
            `Relay failover: ${relayDisplayName(from.kind)} -> ${relayDisplayName(
              to.kind
            )} (${reason})`
          );
        },
        onPermanentFailure: (error) => {
          log.error("Voice relay exhausted all targets:", error.message);
          setState((s) => ({ ...s, isConnected: false }));
          onError?.(
            error.message || "Voice connection error. Is the relay server running?"
          );
        },
      });

      relayConnectorRef.current = connector;
      await connector.connect();
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Voice connection failed";
      onError?.(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onError, playAudio, interviewContext]);

  /** Extract text from a Volcengine event payload, trying common field names */
  const extractText = useCallback(
    (data: Record<string, unknown> | undefined): string => {
      if (!data) return "";
      for (const key of ["text", "content", "sentence", "delta"]) {
        if (typeof data[key] === "string" && data[key]) return data[key] as string;
      }
      return "";
    },
    []
  );

  /** Save accumulated messages to the server (incremental, non-completing).
   *  Called on each question transition so progress is not lost. */
  const saveProgress = useCallback(
    async (currentQuestionIndex: number) => {
      // Flush any remaining ASR buffer (chatBuffer is already cleared
      // before this is called by the question_change handler).
      const pendingAsrText = asrBufferRef.current.trim();
      if (pendingAsrText) {
        trackedMessagesRef.current.push({ role: "user", content: pendingAsrText });
        asrBufferRef.current = "";
      }

      const messages = [...trackedMessagesRef.current];
      trackedMessagesRef.current = []; // clear so next question starts fresh

      if (messages.length === 0 && typeof currentQuestionIndex !== "number") return;

      try {
        await fetch("/api/voice/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, messages, currentQuestionIndex }),
        });
        log.info(
          `Progress saved: ${messages.length} msgs, Q${currentQuestionIndex + 1}`
        );
      } catch (err) {
        log.error("Failed to save progress:", err);
      }
    },
    [sessionId]
  );

  /** Handle JSON messages from relay */
  const handleRelayMessage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: Record<string, any>) => {
      switch (msg.type) {
        case "ready":
          log.info("Session ready:", msg.sessionId);
          setState((s) => ({ ...s, isConnected: true }));
          break;

        case "processing_start":
          log.info("Relay signaled processing_start");
          setState((s) => ({ ...s, isProcessing: true }));
          break;

        case "interrupt":
          interruptPlayback();
          setState((s) => ({ ...s, isProcessing: false }));
          if (chatBufferRef.current.trim()) {
            const text = chatBufferRef.current.trim();
            setState((s) => ({ ...s, aiTranscript: text }));
            chatBufferRef.current = "";
          }
          break;

        case "asr": {
          // If Web Speech API is actively producing words within 1500ms, prefer it
          if (webSpeechActiveRef.current && Date.now() - webSpeechLastActiveAtRef.current < 1500) {
            break;
          }
          // ASR transcript chunk from Volcengine / Whisper — accumulate.
          const results =
            (msg.data?.results as Array<Record<string, unknown>>) || [];
          if (results.length > 0) {
            const rawText = (results[0].text as string) || "";
            if (!rawText.trim()) {
              asrBufferRef.current = "";
              setState((s) => ({ ...s, userTranscript: "" }));
              break;
            }
            if (isSpeakerEcho(rawText)) {
              asrBufferRef.current = "";
              setState((s) => ({ ...s, userTranscript: "" }));
              break;
            }
            const echoCheck = stripAssistantEcho(rawText, [
              chatBufferRef.current.trim(),
              ...recentAiUtterancesRef.current,
            ].filter(Boolean));
            if (echoCheck.isFullEcho || !echoCheck.cleanedText) {
              asrBufferRef.current = "";
              setState((s) => ({ ...s, userTranscript: "" }));
              break;
            }
            const cleanText = echoCheck.cleanedText;
            if (cleanText.trim() && !isWhisperHallucination(cleanText, interviewContext.language)) {
              asrBufferRef.current = cleanText.trim();
              setState((s) => ({ ...s, userTranscript: cleanText }));
              onTranscriptRef.current?.(cleanText, false);
            } else if (isWhisperHallucination(cleanText, interviewContext.language)) {
              asrBufferRef.current = "";
              setState((s) => ({ ...s, userTranscript: "" }));
            }
          }
          break;
        }

        case "asr_ended": {
          // If Web Speech API handled this turn, suppress server Whisper final to avoid duplicate/hallucinated text
          if (webSpeechActiveRef.current && Date.now() - webSpeechLastActiveAtRef.current < 1500) {
            asrBufferRef.current = "";
            break;
          }
          const rawFinalText =
            (typeof msg.text === "string" && msg.text.trim()) || asrBufferRef.current;
          if (!rawFinalText) {
            asrBufferRef.current = "";
            break;
          }

          const echoCheck = stripAssistantEcho(rawFinalText, [
            chatBufferRef.current.trim(),
            ...recentAiUtterancesRef.current,
          ].filter(Boolean));

          if (echoCheck.isFullEcho || !echoCheck.cleanedText) {
            log.info(`Suppressed echo in asr_ended: "${rawFinalText}"`);
            asrBufferRef.current = "";
            break;
          }

          const finalText = echoCheck.cleanedText;
          if (finalText && !isWhisperHallucination(finalText, interviewContext.language)) {
            const normalized = finalText.replace(/\s+/g, " ").trim().toLowerCase();
            const lastFinal = lastFinalUserTranscriptRef.current;
            const isDuplicateFinal =
              !!lastFinal &&
              lastFinal.text === normalized &&
              Date.now() - lastFinal.at < 15_000;

            if (isDuplicateFinal) {
              log.debug(`Skipping duplicate USER final: "${normalized.slice(0, 60)}..."`);
            } else {
              lastFinalUserTranscriptRef.current = { text: normalized, at: Date.now() };
              onTranscriptRef.current?.(finalText, true);
              trackedMessagesRef.current.push({
                role: "user",
                content: finalText,
              });
              log.debug(
                `Tracked USER: "${finalText.slice(0, 60)}..."`
              );
            }
          }
          asrBufferRef.current = "";
          setState((s) => ({
            ...s,
            userTranscript: "",
            isProcessing: !!finalText,
          }));
          break;
        }

        case "chat": {
          const text = extractText(msg.data);
          if (text) {
            chatBufferRef.current += text;
            setState((s) => ({
              ...s,
              aiTranscript: chatBufferRef.current,
              lastAssistantUtteranceEndedAt: 0,
              isProcessing: false,
            }));
          }
          break;
        }

        case "tts_text": {
          if (candidateTurnTimerRef.current) {
            clearTimeout(candidateTurnTimerRef.current);
            candidateTurnTimerRef.current = null;
          }
          accumulatedSpeechRef.current = "";
          lastAiSpeechEndedAtRef.current = Date.now();
          const text = extractText(msg.data);
          if (text) {
            const isDelta = Boolean(
              msg.data &&
              typeof msg.data === "object" &&
              (msg.data as { delta?: boolean }).delta === true
            );
            if (isDelta) {
              chatBufferRef.current += text;
            } else {
              const needsSpace =
                Boolean(chatBufferRef.current) &&
                !/\s$/.test(chatBufferRef.current) &&
                !/^\s/.test(text) &&
                !/^[.,!?;:'"’)\]]/.test(text);
              chatBufferRef.current += (needsSpace ? " " : "") + text;
            }
            const cleanedTranscript = chatBufferRef.current
              .replace(/\[(?:call\s+)?[a-zA-Z0-9_]+(?:\(.*?\))?\]/gi, "")
              .replace(/\s+([.,!?;:])/g, "$1")
              .trim();
            setState((s) => ({
              ...s,
              aiTranscript: cleanedTranscript,
              lastAssistantUtteranceEndedAt: 0,
              isProcessing: false,
            }));
            log.debug(
              `TTS sentence: "${text.slice(0, 80)}..."`
            );
          }
          break;
        }

        case "tts_sentence_end":
          break;

        case "chat_ended":
        case "tts_ended": {
          lastAiSpeechEndedAtRef.current = Date.now();
          const incomingText =
            typeof msg.text === "string"
              ? msg.text
              : extractText(msg.data as Record<string, unknown> | undefined);
          const sourceText = incomingText.trim() || chatBufferRef.current;
          const rawResponse = sourceText
            .replace(/\[(?:call\s+)?[a-zA-Z0-9_]+(?:\(.*?\))?\]/gi, "")
            .trim();
          const fullResponse = rawResponse.replace(/\s+([.,!?;:])/g, "$1").trim();
          chatBufferRef.current = "";
          asrBufferRef.current = "";
          // Keep last transcript visible until next AI speech (replaced by tts_text/chat)
          setState((s) => ({
            ...s,
            aiTranscript: fullResponse,
            userTranscript: "",
            lastAssistantUtteranceEndedAt:
              msg.type === "tts_ended" ? Date.now() : s.lastAssistantUtteranceEndedAt,
            isProcessing: false,
          }));
          if (fullResponse) {
            recentAiUtterancesRef.current.push(fullResponse);
            if (recentAiUtterancesRef.current.length > 25) {
              recentAiUtterancesRef.current.shift();
            }
            // Dedupe: chat_ended and tts_ended often both fire for same response.
            // Use dedicated ref — trackedMessagesRef can lag; normalize for comparison.
            const normalized = fullResponse.replace(/\s+/g, " ").trim();
            const lastSent = lastOnAIResponseRef.current.replace(/\s+/g, " ").trim();
            if (normalized === lastSent) {
              log.debug(`Skipping duplicate ASSISTANT (${msg.type})`);
            } else {
              lastOnAIResponseRef.current = fullResponse;
              onAIResponse?.(fullResponse);
              trackedMessagesRef.current.push({
                role: "assistant",
                content: fullResponse,
              });
              log.debug(
                `Tracked ASSISTANT (${msg.type}): "${fullResponse.slice(0, 60)}..."`
              );
            }
          }
          break;
        }

        case "session_reconnecting":
          interruptPlayback();
          if (chatBufferRef.current.trim()) {
            const text = chatBufferRef.current.trim();
            lastOnAIResponseRef.current = text;
            onAIResponse?.(text);
            trackedMessagesRef.current.push({
              role: "assistant",
              content: text,
            });
          }
          chatBufferRef.current = "";
          lastOnAIResponseRef.current = "";
          setState((s) => ({ ...s, aiTranscript: "", isProcessing: true }));
          break;

        case "session_reconnected":
          setState((s) => ({ ...s, isProcessing: false }));
          break;

        case "question_change": {
          // For manual transitions, interrupt immediately so old audio
          // doesn't bleed into the new question. For auto-transitions
          // the wrap-up acknowledgement ("好的，谢谢分享") may still be
          // playing — let it finish naturally; the new question's audio
          // will be queued after it via sequential scheduling.
          if (!msg.auto) {
            interruptPlayback();
          }
          // Discard transition greeting text before saving progress
          chatBufferRef.current = "";
          lastOnAIResponseRef.current = "";
          const idx = msg.questionIndex as number;
          const total = msg.totalQuestions as number;

          // Persist messages from the previous question (fire-and-forget)
          saveProgress(idx);

          setState((s) => ({
            ...s,
            currentQuestionIndex: idx,
            totalQuestions: total,
              isTransitioning: false,
              transitionDirection: null,
              aiTranscript: "",
              lastAssistantUtteranceEndedAt: 0,
            }));
          onQuestionChange?.(idx, total);
          log.info(`Question ${idx + 1}/${total}`);
          break;
        }

        case "transitioning": {
          const dir = (msg.direction as "next" | "previous") ?? "next";
          if (!msg.auto) {
            interruptPlayback();
            chatBufferRef.current = "";
            setState((s) => ({
              ...s,
              isTransitioning: true,
              transitionDirection: dir,
              isSpeaking: false,
              aiTranscript: "",
              lastAssistantUtteranceEndedAt: 0,
            }));
          } else {
            setState((s) => ({
              ...s,
              isTransitioning: true,
              transitionDirection: dir,
            }));
          }
          break;
        }

        case "interview_complete":
          log.info("Interview complete, wrapping up");
          setState((s) => ({ ...s, isInterviewComplete: true }));
          break;

        case "error": {
          const message = (msg.message as string) || "Relay error";
          if (
            isRecoverableRelayErrorMessage(message) &&
            relayConnectorRef.current?.canFailover
          ) {
            log.warn(`Recoverable relay error ignored during failover window: ${message}`);
            break;
          }
          onError?.(message);
          break;
        }

        case "disconnected":
          setState((s) => ({ ...s, isConnected: false }));
          if (relayConnectorRef.current?.canFailover) {
            void relayConnectorRef.current.failover("relay disconnected message");
          }
          break;
      }
    },
    [interruptPlayback, extractText, onTranscript, onAIResponse, onError, onQuestionChange, saveProgress]
  );

  const clientSpeechFramesRef = useRef(0);
  const clientPreRollRef = useRef<string[]>([]);
  const clientGateOpenRef = useRef(false);
  const clientLastVoiceAtRef = useRef(0);

  // Web Speech API for zero-cost, hallucination-free in-browser transcription
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const speechRecognitionRef = useRef<any>(null);
  const webSpeechActiveRef = useRef(false);
  const webSpeechLastActiveAtRef = useRef(0);

  /** Start capturing microphone audio and sending to relay */
  const startListening = useCallback(async () => {
    if (isListeningRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const actualSampleRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);

      const handleAudioChunk = (inputData: Float32Array) => {
        if (!isListeningRef.current) return;
        const connector = relayConnectorRef.current;
        if (!connector?.isReady) return;

        // Compute RMS audio level (float32 range 0..1)
        let sumSq = 0;
        for (let i = 0; i < inputData.length; i++) sumSq += inputData[i] * inputData[i];
        const rms = Math.sqrt(sumSq / inputData.length);
        const level = Math.min(1, rms * 5);
        setState((s) => ({ ...s, audioLevel: level }));

        // Resample from hardware rate to 24000 Hz int16 PCM
        const pcm24 = downsampleTo24k(inputData, actualSampleRate);

        // Send as hex-encoded string
        const bytes = new Uint8Array(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength);
        const hex = toHex(bytes);

        const isAiSpeakingOrEcho =
          audioSourcesRef.current.length > 0 || performance.now() < micHoldUntilRef.current;

        if (isAiSpeakingOrEcho) {
          // AI model is speaking or in post-playback echo cooldown: suppress audio to prevent speaker echo unless user barges in
          if (rms < BARGE_IN_RMS_THRESHOLD) {
            bargeInFramesRef.current = 0;
            return;
          }

          bargeInFramesRef.current += 1;
          if (bargeInFramesRef.current < BARGE_IN_FRAME_COUNT) {
            return;
          }

          // Sustained candidate speech interrupts playback
          micHoldUntilRef.current = 0;
          bargeInFramesRef.current = 0;
          interruptPlayback();
        } else {
          bargeInFramesRef.current = 0;
        }

        const now = performance.now();
        const CLIENT_SPEECH_OPEN_RMS = 0.006;
        const CLIENT_SPEECH_HOLD_RMS = 0.003;
        const CLIENT_SPEECH_HANGOVER_MS = 800;

        if (rms >= CLIENT_SPEECH_OPEN_RMS) {
          clientLastVoiceAtRef.current = now;
          if (!clientGateOpenRef.current) {
            clientGateOpenRef.current = true;
            // Flush pre-roll chunks so leading consonants are intact
            if (clientPreRollRef.current.length > 0) {
              for (const pr of clientPreRollRef.current) {
                connector.sendJson({ type: "audio", data: pr, sampleRate: 24000 });
              }
              clientPreRollRef.current = [];
            }
          }
        }

        if (clientGateOpenRef.current) {
          if (rms >= CLIENT_SPEECH_HOLD_RMS) {
            clientLastVoiceAtRef.current = now;
          }
          connector.sendJson({ type: "audio", data: hex, sampleRate: 24000 });
          if (now - clientLastVoiceAtRef.current >= CLIENT_SPEECH_HANGOVER_MS) {
            clientGateOpenRef.current = false;
            clientPreRollRef.current = [];
          }
        } else {
          // Keep up to 6 pre-roll chunks (~300-500ms) while candidate is silent
          clientPreRollRef.current.push(hex);
          if (clientPreRollRef.current.length > 6) {
            clientPreRollRef.current.shift();
          }
        }
      };

      let workletNode: AudioWorkletNode | null = null;
      let scriptProcessor: ScriptProcessorNode | null = null;

      if (ctx.audioWorklet) {
        try {
          const workletCode = `
            class VoiceInputProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this._buf = new Float32Array(2048);
                this._pos = 0;
              }
              process(inputs) {
                const ch = inputs[0]?.[0];
                if (!ch) return true;
                for (let i = 0; i < ch.length; i++) {
                  this._buf[this._pos++] = ch[i];
                  if (this._pos >= 2048) {
                    this.port.postMessage(this._buf);
                    this._buf = new Float32Array(2048);
                    this._pos = 0;
                  }
                }
                return true;
              }
            }
            registerProcessor('voice-input-processor', VoiceInputProcessor);
          `;
          const blob = new Blob([workletCode], { type: "application/javascript" });
          const workletUrl = URL.createObjectURL(blob);
          await ctx.audioWorklet.addModule(workletUrl);
          URL.revokeObjectURL(workletUrl);

          workletNode = new AudioWorkletNode(ctx, "voice-input-processor");
          workletNode.port.onmessage = (e) => {
            handleAudioChunk(e.data as Float32Array);
          };
          source.connect(workletNode);
          workletNode.connect(ctx.destination);
        } catch (workletErr) {
          log.warn("AudioWorklet failed, falling back to ScriptProcessor:", workletErr);
          workletNode = null;
        }
      }

      if (!workletNode) {
        scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        source.connect(scriptProcessor);
        scriptProcessor.connect(silentGain);
        silentGain.connect(ctx.destination);
        scriptProcessor.onaudioprocess = (event) => {
          handleAudioChunk(event.inputBuffer.getChannelData(0));
        };
      }

      processorRef.current = { workletNode, scriptProcessor, source, ctx };
      isListeningRef.current = true;
      setState((s) => ({ ...s, isListening: true, userTranscript: "" }));

      // ── Native Web Speech API for real-time, zero-cost, hallucination-free transcription ──
      if (typeof window !== "undefined") {
        const SpeechRec =
          (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition ||
          (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }).webkitSpeechRecognition;

        if (SpeechRec) {
          try {
            const recognition = new SpeechRec();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;

            const langRaw = (interviewContext.language || "en").toLowerCase();
            recognition.lang = langRaw.startsWith("zh")
              ? "zh-CN"
              : langRaw.startsWith("es")
              ? "es-ES"
              : langRaw.startsWith("fr")
              ? "fr-FR"
              : langRaw.startsWith("de")
              ? "de-DE"
              : langRaw.startsWith("ja")
              ? "ja-JP"
              : "en-US";

            recognition.onresult = (event: any) => {
              let interim = "";
              let finalChunk = "";

              for (let i = event.resultIndex; i < event.results.length; i++) {
                const res = event.results[i];
                const text = res[0]?.transcript || "";
                if (res.isFinal) {
                  finalChunk += text;
                } else {
                  interim += text;
                }
              }

              const isAudioCurrentlyPlaying =
                audioSourcesRef.current.length > 0 ||
                performance.now() < micHoldUntilRef.current ||
                Date.now() - lastAiSpeechEndedAtRef.current < 2000;

              const cleanInterim = interim.trim();
              if (cleanInterim) {
                if (isAudioCurrentlyPlaying || isSpeakerEcho(cleanInterim)) {
                  return;
                }
                // Clear any pending turn finalization while candidate is speaking interim words
                if (candidateTurnTimerRef.current) {
                  clearTimeout(candidateTurnTimerRef.current);
                  candidateTurnTimerRef.current = null;
                }
                webSpeechActiveRef.current = true;
                webSpeechLastActiveAtRef.current = Date.now();
                const displayTranscript = accumulatedSpeechRef.current
                  ? `${accumulatedSpeechRef.current} ${cleanInterim}`
                  : cleanInterim;
                setState((s) => ({ ...s, userTranscript: displayTranscript }));
                onTranscriptRef.current?.(displayTranscript, false);
              }

              const cleanFinal = finalChunk.trim();
              if (cleanFinal) {
                // Suppress speaker echo against recent AI speech and speaker playback state
                if (isAudioCurrentlyPlaying || isSpeakerEcho(cleanFinal)) {
                  log.info(`Suppressed audio during AI speech playback or echo: "${cleanFinal}"`);
                  accumulatedSpeechRef.current = "";
                  return;
                }

                const echoCheck = stripAssistantEcho(cleanFinal, [
                  chatBufferRef.current.trim(),
                  ...recentAiUtterancesRef.current,
                ].filter(Boolean));

                if (echoCheck.isFullEcho || !echoCheck.cleanedText) {
                  log.info(`Suppressed speaker acoustic echo in candidate transcript: "${cleanFinal}"`);
                  accumulatedSpeechRef.current = "";
                  return;
                }

                const effectiveFinal = echoCheck.cleanedText;

                // Suppress Whisper / ASR silence hallucinations
                if (isWhisperHallucination(effectiveFinal, interviewContext.language)) {
                  log.info(`Suppressed hallucination in candidate transcript: "${effectiveFinal}"`);
                  return;
                }

                webSpeechActiveRef.current = true;
                webSpeechLastActiveAtRef.current = Date.now();

                // Accumulate effectiveFinal into our active answer buffer
                accumulatedSpeechRef.current = accumulatedSpeechRef.current
                  ? `${accumulatedSpeechRef.current} ${effectiveFinal}`
                  : effectiveFinal;
                const fullText = accumulatedSpeechRef.current;

                // Guard against accumulated speech concatenating speaker bleed fragments
                const fullEchoCheck = stripAssistantEcho(fullText, [
                  chatBufferRef.current.trim(),
                  ...recentAiUtterancesRef.current,
                ].filter(Boolean));
                if (fullEchoCheck.isFullEcho || !fullEchoCheck.cleanedText) {
                  log.info(`Suppressed accumulated speaker echo: "${fullText}"`);
                  accumulatedSpeechRef.current = "";
                  return;
                }

                setState((s) => ({ ...s, userTranscript: fullText }));
                onTranscriptRef.current?.(fullText, false);

                // 1. Check if the candidate explicitly signaled verbal completion
                if (isAnswerDoneSignal(effectiveFinal) || isCodingDoneSignal(effectiveFinal) || isAnswerDoneSignal(fullText)) {
                  log.info(`Verbal completion signal detected in "${effectiveFinal}" — finalizing turn immediately`);
                  commitCandidateTurn(fullText, "verbal_completion");
                  return;
                }

                // 2. Otherwise buffer: 1500ms for brief audio checks/greetings, 3500ms for technical answers, 6000ms for incomplete
                if (candidateTurnTimerRef.current) {
                  clearTimeout(candidateTurnTimerRef.current);
                }

                const isBrief = isAudioConfirmationOrGreeting(fullText);
                const isIncomplete = hasTrailingIncompleteThought(fullText);
                const silenceDelay = isBrief ? 1500 : (isIncomplete ? 6000 : 3500);

                candidateTurnTimerRef.current = setTimeout(() => {
                  candidateTurnTimerRef.current = null;
                  commitCandidateTurn(accumulatedSpeechRef.current, "silence_timeout");
                }, silenceDelay);
              }
            };

            recognition.onerror = (e: any) => {
              // 'no-speech' is expected during periods of silence
              if (e.error !== "no-speech" && e.error !== "audio-capture") {
                log.warn("Web Speech API status:", e.error);
              }
            };

            recognition.onend = () => {
              // Automatically resume recognition as long as the interview is listening and AI is NOT speaking
              if (
                isListeningRef.current &&
                audioSourcesRef.current.length === 0 &&
                performance.now() >= micHoldUntilRef.current
              ) {
                setTimeout(() => {
                  if (
                    isListeningRef.current &&
                    audioSourcesRef.current.length === 0 &&
                    performance.now() >= micHoldUntilRef.current
                  ) {
                    try {
                      recognition.start();
                    } catch {
                      // Ignore if already active
                    }
                  }
                }, 100);
              }
            };

            recognition.start();
            speechRecognitionRef.current = recognition;
            log.info("Native Web Speech API active for real-time transcription");
          } catch (recErr) {
            log.warn("Could not start Web Speech Recognition, falling back to server ASR:", recErr);
          }
        }
      }
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Microphone access failed";
      onError?.(msg);
    }
  }, [onError, onTranscript, interviewContext.language, commitCandidateTurn]);

  /** Stop capturing microphone */
  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    clientGateOpenRef.current = false;
    clientPreRollRef.current = [];

    // Capture and commit any pending candidate speech transcript before tearing down
    const pendingText = (accumulatedSpeechRef.current || asrBufferRef.current || state.userTranscript || "").trim();
    if (pendingText) {
      log.info(`Flushing pending candidate speech on mute: "${pendingText}"`);
      commitCandidateTurn(pendingText, "mute");
    } else if (relayConnectorRef.current?.isReady) {
      relayConnectorRef.current.sendJson({ type: "candidate_turn_done", reason: "mute" });
    }

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.onend = null;
        speechRecognitionRef.current.stop();
      } catch {
        // noop
      }
      speechRecognitionRef.current = null;
    }
    webSpeechActiveRef.current = false;

    if (processorRef.current) {
      const { workletNode, scriptProcessor, source, ctx } = processorRef.current;
      try {
        workletNode?.disconnect();
        scriptProcessor?.disconnect();
        source?.disconnect();
        ctx?.close();
      } catch {
        // already closed
      }
      processorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    setState((s) => ({ ...s, isListening: false, audioLevel: 0, userTranscript: "", isProcessing: true }));
  }, [state.userTranscript, onTranscript]);

  /** Request transition to the next question */
  const nextQuestion = useCallback(() => {
    relayConnectorRef.current?.sendJson({ type: "next_question" });
  }, []);

  /** Request transition back to the previous question */
  const previousQuestion = useCallback(() => {
    relayConnectorRef.current?.sendJson({ type: "prev_question" });
  }, []);

  /** Send a text message through the relay (treated like a voice utterance).
   *  The caller is responsible for adding the message to the UI display;
   *  this method only tracks it for server persistence and sends it to the relay. */
  const sendTextMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const connector = relayConnectorRef.current;
      if (!connector?.isReady) return;

      trackedMessagesRef.current.push({ role: "user", content: trimmed, source: "chat" });
      connector.sendJson({ type: "text_input", content: trimmed });
    },
    [],
  );

  /** Send code editor content to the relay for agent context */
  const sendCodeUpdate = useCallback((content: string, language: string) => {
    latestCodeUpdateRef.current = { content, language };
    relayConnectorRef.current?.sendJson({ type: "code_update", content, language });
  }, []);

  /** Send whiteboard image to the relay for agent context */
  const sendWhiteboardUpdate = useCallback((imageDataUrl: string) => {
    latestWhiteboardUpdateRef.current = imageDataUrl;
    relayConnectorRef.current?.sendJson({ type: "whiteboard_update", imageDataUrl });
  }, []);

  /** Send proctoring event to the relay for conversational intervention */
  const sendProctorAlert = useCallback((alertType: string, detail?: string) => {
    relayConnectorRef.current?.sendJson({ type: "proctor_alert", alertType, detail });
  }, []);

  /** Send time limit expired event to the relay to deliver spoken conclusion */
  const sendTimeExpired = useCallback(() => {
    relayConnectorRef.current?.sendJson({ type: "time_expired" });
  }, []);

  /** Send code execution results (logs, formatted output, runtime) to relay */
  const sendCodeExecutionResult = useCallback(
    (payload: {
      language: string;
      code: string;
      success: boolean;
      logs: string[];
      resultFormatted?: string;
      error?: string;
      executionTimeMs: number;
    }) => {
      relayConnectorRef.current?.sendJson({
        type: "code_execution_result",
        ...payload,
      });
    },
    []
  );

  /** Send arbitrary JSON message to relay */
  const sendJson = useCallback((data: Record<string, unknown>) => {
    relayConnectorRef.current?.sendJson(data);
  }, []);

  /** Save remaining tracked messages and complete the session */
  const saveAndComplete = useCallback(async () => {
    // Flush any pending buffers before saving
    const pendingAsrText = asrBufferRef.current.trim();
    if (pendingAsrText) {
      trackedMessagesRef.current.push({ role: "user", content: pendingAsrText });
      asrBufferRef.current = "";
    }
    const pendingChatText = chatBufferRef.current.trim();
    if (pendingChatText) {
      trackedMessagesRef.current.push({
        role: "assistant",
        content: pendingChatText,
      });
      chatBufferRef.current = "";
    }

    const messages = trackedMessagesRef.current;
    if (messages.length === 0 && !sessionId) return;

    log.info(
      `Saving ${messages.length} remaining messages and completing session`
    );

    try {
      await fetch("/api/voice/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          messages,
          complete: true,
        }),
      });
    } catch (err) {
      log.error("Failed to save voice data:", err);
    }
  }, [sessionId]);

  /** Disconnect, save messages, and clean up everything */
  const disconnect = useCallback(async () => {
    // Immediately terminate audio playback and disconnect relay so all speech ceases with 0ms delay
    interruptPlayback();
    stopListening();
    if (audioContextRef.current) {
      try {
        void audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
    relayConnectorRef.current?.close();
    relayConnectorRef.current = null;

    setState((s) => ({
      ...s,
      isSaving: true,
      isConnected: false,
      isListening: false,
      isSpeaking: false,
    }));
    try {
      await saveAndComplete();
    } finally {
      cleanup();
      // isSaving is reset by cleanup
    }
  }, [interruptPlayback, stopListening, saveAndComplete, cleanup]);

  /** Explicit candidate trigger to complete their answer and request AI response */
  const finishAnswer = useCallback(() => {
    const pendingText = (accumulatedSpeechRef.current || asrBufferRef.current || state.userTranscript || "").trim();
    if (pendingText) {
      log.info(`finishAnswer: candidate manually completed answer (${pendingText.length} chars)`);
      commitCandidateTurn(pendingText, "user_done_button");
    } else if (relayConnectorRef.current?.isReady) {
      log.info("finishAnswer: triggered without local text — notifying relay");
      relayConnectorRef.current.sendJson({
        type: "candidate_turn_done",
        reason: "user_done_button",
      });
      setState((s) => ({ ...s, isProcessing: true }));
    }
  }, [commitCandidateTurn, state.userTranscript]);

  return {
    ...state,
    connect,
    disconnect,
    startListening,
    stopListening,
    finishAnswer,
    nextQuestion,
    previousQuestion,
    sendTextMessage,
    sendCodeUpdate,
    sendWhiteboardUpdate,
    sendProctorAlert,
    sendTimeExpired,
    sendCodeExecutionResult,
    sendJson,
    interruptPlayback,
    mediaStreamRef,
  };
}
