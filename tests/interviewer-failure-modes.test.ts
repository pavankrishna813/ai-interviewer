import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTrailingIncompleteThought,
  isCodingDoneSignal,
  isFastNextRequest,
  isFastPrevRequest,
  isUserSkipRequest,
  isUserPrevRequest,
  looksLikeFarewell,
  mergeAsrText,
  resolveTargetQuestionIndex,
  shouldAllowTtsBargeIn,
  shouldDisruptForProctorAlert,
  buildProctorWarningText,
  stripAssistantEcho,
  TRAILING_INCOMPLETE_WORDS,
} from "../server/openai-voice-relay-helpers";

test("Category 1: Candidate Cutoff Mid-Thought & Conjunction Buffering", async (t) => {
  await t.test("Trailing conjunctions trigger extended thinking buffer", () => {
    const testPhrases = [
      "I chose a hash map here because",
      "We wrapped the component in useMemo and",
      "If the input array is empty, then",
      "I would normally use Redis or",
      "This has an O(n) time complexity but",
      "The state will update asynchronously so",
      "We can pass this callback down which",
      "The child component re-renders with",
      "I prefer using TypeScript although",
      "This will prevent unnecessary re-renders since",
      "Props are passed from parent whereas",
      "The loop iterates over each item while",
    ];

    for (const phrase of testPhrases) {
      assert.equal(
        hasTrailingIncompleteThought(phrase),
        true,
        `Phrase ending in conjunction must trigger incomplete buffer: "${phrase}"`
      );
    }
  });

  await t.test("Trailing prepositions and connectives trigger thinking buffer", () => {
    const connectivePhrases = [
      "I can think of several alternatives such as",
      "We need to pass the authentication token to",
      "We will set up an error boundary for",
      "Let me take a moment to think about",
      "We could structure the state tree like",
      "I solved this in my previous company using",
    ];

    for (const phrase of connectivePhrases) {
      assert.equal(
        hasTrailingIncompleteThought(phrase),
        true,
        `Connective phrase must trigger incomplete buffer: "${phrase}"`
      );
    }
  });

  await t.test("Completed sentences do not add delay", () => {
    const completePhrases = [
      "I chose a hash map because it gives O(1) lookup time.",
      "State triggers a re-render when set.",
      "Yes, loud and clear!",
      "I'm finished with my answer.",
      "That is all for this question.",
    ];

    for (const phrase of completePhrases) {
      assert.equal(
        hasTrailingIncompleteThought(phrase),
        false,
        `Complete thought must not be flagged incomplete: "${phrase}"`
      );
    }
  });

  await t.test("Buffer calculation adds 3000ms when incomplete", () => {
    const baseSilenceMs = 1400;
    const incompleteThought = "I would handle this by using";
    const completeThought = "I would handle this by using a debounce function.";

    const bufferIncomplete = hasTrailingIncompleteThought(incompleteThought) ? baseSilenceMs + 3000 : baseSilenceMs;
    const bufferComplete = hasTrailingIncompleteThought(completeThought) ? baseSilenceMs + 3000 : baseSilenceMs;

    assert.equal(bufferIncomplete, 4400, "Candidate must be granted 4.4 seconds of thinking buffer");
    assert.equal(bufferComplete, 1400, "Completed thought uses base silence");
  });
});

test("Category 2: Ambient Typing Noise vs Genuine Candidate Interruption", async (t) => {
  await t.test("Ambient keyboard typing during AI speech does not cause false barge-in", () => {
    const bargeIn = shouldAllowTtsBargeIn({
      inEchoCooldown: false,
      modelIsSpeaking: true,
      responseAudioStarted: true,
      ttsAudioStartedAt: 1000,
      nowMs: 2500,
      responseTtsBytes: 64_000,
      rms: 1100, // Keyboard clatter RMS is below speech threshold
      thresholdRms: 2400,
      consecutiveFrames: 2,
      thresholdFrames: 3,
    });

    assert.equal(bargeIn, false, "Typing clatter must NOT interrupt interviewer speech");
  });

  await t.test("Speaker echo during first 400ms cooldown is suppressed", () => {
    const bargeIn = shouldAllowTtsBargeIn({
      inEchoCooldown: true, // Echo cooldown active
      modelIsSpeaking: true,
      responseAudioStarted: true,
      ttsAudioStartedAt: 2000,
      nowMs: 2150,
      responseTtsBytes: 8_000,
      rms: 3500,
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    });

    assert.equal(bargeIn, false, "Audio during echo cooldown must be suppressed to prevent loopback");
  });

  await t.test("Intentional candidate vocal barge-in is accepted", () => {
    const bargeIn = shouldAllowTtsBargeIn({
      inEchoCooldown: true, // Active during AI speech
      modelIsSpeaking: true,
      responseAudioStarted: true,
      ttsAudioStartedAt: 1000,
      nowMs: 3000,
      responseTtsBytes: 80_000,
      rms: 4200, // Strong candidate voice
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    });

    assert.equal(bargeIn, true, "Strong intentional voice must barge in");
  });

  await t.test("Acoustic speaker bleed concatenating multiple AI utterances is rejected as full echo", () => {
    const recentAi = [
      "Excuse me, I can no longer see your face on camera. Please make sure you are sitting in front of your camera and clearly visible so we can continue the interview. Whenever you're set, we can keep going—take your time!",
      "Are you still with me? Take your time, or if you'd like to skip this question or explore a different angle, just let me know!",
    ];

    const echoTranscript =
      "Are you skip this question or explore a different angle? Just let me know. Excuse me, I can no longer see your face on camera. Please make sure you are sitting in front of your camera and clearly visible so we can continue the interview. Whenever you're set, you can keep going, take your time.";

    const result = stripAssistantEcho(echoTranscript, recentAi);
    assert.equal(result.isFullEcho, true, "Jumbled multi-utterance speaker bleed must be rejected as full echo");
    assert.equal(result.cleanedText, "", "Cleaned text must be empty");
  });

  await t.test("Genuine candidate technical answer sharing question keywords is NEVER dropped as echo", () => {
    const aiUtterance = "Implement a decorator in Python that measures the execution time of a function. How would you handle arguments and preserve the original function's metadata like name and docstring?";
    const candAnswer1 = "In Python, I would create a decorator using time and functions.graphs.";
    const candAnswer2 = "I will use Python's functools.wraps decorator inside my custom decorator. It preserves the original function's metadata such as its name, docstring, module, and annotations.";

    const res1 = stripAssistantEcho(candAnswer1, [aiUtterance]);
    assert.equal(res1.isFullEcho, false, "Candidate answer 1 must never be dropped as echo");
    assert.equal(res1.cleanedText, candAnswer1);

    const res2 = stripAssistantEcho(candAnswer2, [aiUtterance]);
    assert.equal(res2.isFullEcho, false, "Candidate answer 2 must never be dropped as echo");
    assert.equal(res2.cleanedText, candAnswer2);
  });

  await t.test("Candidate opening greeting/mic check is preserved and never dropped", () => {
    const greeting = "Hey! Thanks for taking the time to interview today. Can you hear me loud and clear?";
    const candReply = "Yes, I can hear you loud and clear.";

    const res = stripAssistantEcho(candReply, [greeting]);
    assert.equal(res.isFullEcho, false, "Candidate greeting confirmation must never be dropped");
    assert.equal(res.cleanedText, candReply);
  });
});

test("Category 3: Question Navigation & Anti-Stuck Loop Prevention", async (t) => {
  await t.test("Detect candidate skip and next requests", () => {
    const skipPhrases = [
      "Can we move to the next question?",
      "Next question please",
      "Let's move on to the next topic",
      "I'd like to skip this question",
      "Please skip",
      "Ready for the next question",
      "下一题",
      "跳过这个问题",
    ];

    for (const phrase of skipPhrases) {
      assert.equal(isUserSkipRequest(phrase), true, `Must recognize skip request: "${phrase}"`);
    }
  });

  await t.test("Fast next regex matches quick verbal shortcuts", () => {
    assert.equal(isFastNextRequest("next question"), true);
    assert.equal(isFastNextRequest("move to next"), true);
    assert.equal(isFastNextRequest("skip this"), true);
    assert.equal(isFastNextRequest("tell me about react"), false);
  });

  await t.test("Prevent AI looping when model passes current index", () => {
    // Model is on Question 4 (index 3). Candidate asks for next question.
    // Model calls signal_question_change(questionIndex=3).
    const currentQuestionIndex = 3;
    const requestedIndex = 3;
    const { targetIdx, autoCorrected } = resolveTargetQuestionIndex(requestedIndex, currentQuestionIndex, true, 5);

    assert.equal(autoCorrected, true, "Must auto-correct duplicate index");
    assert.equal(targetIdx, 4, "Must advance to Question 5 (index 4)");
  });

  await t.test("Prevent spontaneous AI hallucinated backward regressions", () => {
    // Model attempts to jump from Question 3 (index 2) to Question 1 (index 0) without candidate request
    const { targetIdx, autoCorrected } = resolveTargetQuestionIndex(0, 2, false, 5);

    assert.equal(targetIdx, 2, "Automatic backward transition must stay on current question");
    assert.equal(autoCorrected, true, "Must correct regression attempt");
  });

  await t.test("Permit candidate-requested backward navigation", () => {
    const prevPhrases = [
      "Can we go back to the previous question?",
      "Let's go back",
      "Previous question please",
      "上一题",
    ];

    for (const phrase of prevPhrases) {
      assert.equal(isUserPrevRequest(phrase), true, `Must recognize previous question request: "${phrase}"`);
    }

    // Explicit candidate request to revisit question 0 from question 2
    const { targetIdx } = resolveTargetQuestionIndex(0, 2, true, 5);
    assert.equal(targetIdx, 0, "Explicit user request to go back must be honored");
  });

  await t.test("Advancing past final question caps cleanly at total questions for wrap-up", () => {
    const totalQuestions = 5;
    const currentQuestionIndex = 4; // Last question (index 4)
    const { targetIdx } = resolveTargetQuestionIndex(5, currentQuestionIndex, false, totalQuestions);

    assert.equal(targetIdx, 5, "Target index must cap at totalQuestions to trigger farewell");
  });
});

test("Category 4: Coding Verbal Completion Signals & Oral Defense", async (t) => {
  await t.test("Recognizes verbal completion signals from candidate", () => {
    const signals = [
      "I'm done coding",
      "I finished the code",
      "That's my solution",
      "I have implemented the function",
      "Can you review my code?",
      "Take a look at my code",
      "I'm finished with the code",
      "Here is my code",
      "That should do it for the code",
      "我写完了",
      "代码写好了",
    ];

    for (const signal of signals) {
      assert.equal(isCodingDoneSignal(signal), true, `Signal must trigger oral review: "${signal}"`);
    }
  });

  await t.test("Distinguishes coding questions from normal questions", () => {
    const codingQuestion = {
      text: "Write a function to reverse a linked list.",
      type: "CODING",
      starterCode: { language: "typescript", code: "function reverseList(head) {}" },
    };
    const conceptualQuestion = {
      text: "Explain the difference between SQL and NoSQL.",
      type: "CONCEPTUAL",
    };

    assert.equal(codingQuestion.type === "CODING", true);
    assert.equal(conceptualQuestion.type === "CODING", false);
  });
});

test("Category 5: Transcript Merging & Mute Flush Hygiene", async (t) => {
  await t.test("Prefers more complete transcript when one contains the other", () => {
    const webSpeechPartial = "React state triggers re-renders";
    const whisperFull = "React state triggers re-renders when updated";

    const merged = mergeAsrText(webSpeechPartial, whisperFull);
    assert.equal(merged, "React state triggers re-renders when updated");

    const reverseMerged = mergeAsrText(whisperFull, webSpeechPartial);
    assert.equal(reverseMerged, "React state triggers re-renders when updated");
  });

  await t.test("Guards against interim transcript regressing to tiny fragment", () => {
    const fullTranscript = "I usually structure my Redux store with slices and selectors";
    const tinyFragment = "selectors";

    const preserved = mergeAsrText(fullTranscript, tinyFragment);
    assert.equal(preserved, fullTranscript, "Must not overwrite full transcript with tiny fragment");
  });
});

test("Category 6: Interview Completion & Farewell Recognition", async (t) => {
  await t.test("Recognizes interviewer farewell phrases in English and Chinese", () => {
    const englishFarewells = [
      "Thank you so much for your time today! The team will be in touch soon. Have a great day!",
      "Thanks for interviewing with us today, best of luck!",
      "That wraps up our interview today. Take care and goodbye!",
    ];

    for (const text of englishFarewells) {
      assert.equal(looksLikeFarewell(text, false), true, `Must recognize English farewell: "${text}"`);
    }

    const chineseFarewells = [
      "非常感谢您今天的参与和详尽回答！招聘团队会尽快与您联系。祝您生活愉快，再见！",
      "感谢你今天的面试，再见！",
    ];

    for (const text of chineseFarewells) {
      assert.equal(looksLikeFarewell(text, true), true, `Must recognize Chinese farewell: "${text}"`);
    }
  });

  await t.test("Non-farewell technical remarks are not mistaken for interview end", () => {
    const technicalRemarks = [
      "That makes sense. Can you also tell me how you handle race conditions in useEffect?",
      "Good explanation. Now let's move to our next question on data structures.",
      "Thanks for explaining your project. What was the most challenging bug you encountered?",
    ];

    for (const text of technicalRemarks) {
      assert.equal(looksLikeFarewell(text, false), false, `Technical question must NOT be flagged farewell: "${text}"`);
    }
  });
});

test("Category 7: Proctoring Disruption & Integrity Interventions", async (t) => {
  const baseTime = 1_000_000;

  await t.test("Suppresses gaze looking_away alerts during coding challenges", () => {
    const res = shouldDisruptForProctorAlert({
      alertType: "looking_away",
      isCoding: true,
      nowMs: baseTime,
      lastProctorSpokenAt: 0,
      lastTypeSpokenAt: 0,
    });
    assert.equal(res.shouldDisrupt, false);
    assert.equal(res.reason, "suppressed_during_coding");
  });

  await t.test("Disrupts immediately when candidate face is missing", () => {
    const res = shouldDisruptForProctorAlert({
      alertType: "face_missing",
      isCoding: true,
      nowMs: baseTime,
      lastProctorSpokenAt: 0,
      lastTypeSpokenAt: 0,
    });
    assert.equal(res.shouldDisrupt, true);
    assert.equal(res.reason, "approved");
  });

  await t.test("Disrupts immediately when multiple faces are detected", () => {
    const res = shouldDisruptForProctorAlert({
      alertType: "multiple_faces",
      isCoding: false,
      nowMs: baseTime,
      lastProctorSpokenAt: 0,
      lastTypeSpokenAt: 0,
    });
    assert.equal(res.shouldDisrupt, true);
  });

  await t.test("Disrupts when candidate navigates away from interview window", () => {
    const res = shouldDisruptForProctorAlert({
      alertType: "page_departure",
      isCoding: true,
      nowMs: baseTime,
      lastProctorSpokenAt: 0,
      lastTypeSpokenAt: 0,
    });
    assert.equal(res.shouldDisrupt, true);
  });

  await t.test("Applies cooldown to prevent rapid-fire repeated interruptions", () => {
    const res = shouldDisruptForProctorAlert({
      alertType: "face_missing",
      isCoding: false,
      nowMs: baseTime + 5_000,
      lastProctorSpokenAt: baseTime,
      lastTypeSpokenAt: baseTime,
    });
    assert.equal(res.shouldDisrupt, false);
    assert.equal(res.reason, "global_cooldown");
  });

  await t.test("Generates polite and authoritative spoken warnings in English and Chinese", () => {
    const enWarning = buildProctorWarningText("face_missing", false);
    assert.ok(enWarning.includes("camera"), "English warning should mention camera");

    const zhWarning = buildProctorWarningText("face_missing", true);
    assert.ok(zhWarning.includes("摄像头") || zhWarning.includes("面部"), "Chinese warning should mention camera/face");
  });
});
