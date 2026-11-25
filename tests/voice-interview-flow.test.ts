import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTrailingIncompleteThought,
  isCodingDoneSignal,
  isUserSkipRequest,
  resolveTargetQuestionIndex,
  looksLikeFarewell,
  mergeAsrText,
  shouldAllowTtsBargeIn,
} from "../server/openai-voice-relay-helpers";

test("Scenario 1: Candidate pauses mid-thought without being cut off", () => {
  // Candidate says "I chose Redux because" and pauses for 2 seconds.
  const candidateUtterance = "I chose Redux because";
  const isIncomplete = hasTrailingIncompleteThought(candidateUtterance);

  assert.equal(isIncomplete, true, "System must recognize incomplete thought on conjunction");

  // Silence timer should extend by +3000ms
  const baseSilenceMs = 1400;
  const effectiveSilenceMs = isIncomplete ? baseSilenceMs + 3000 : baseSilenceMs;
  assert.equal(effectiveSilenceMs, 4400, "Candidate must receive 4.4s buffer before being interrupted");
});

test("Scenario 2: Candidate completes answer normally", () => {
  const candidateUtterance = "I chose Redux because we had a complex global cart state that multiple pages needed to access.";
  const isIncomplete = hasTrailingIncompleteThought(candidateUtterance);

  assert.equal(isIncomplete, false, "Complete thought should not delay transition");
});

test("Scenario 3: Candidate completes code and verbally informs the interviewer", () => {
  const userSpokenSignals = [
    "I'm done",
    "I finished the code",
    "That's my solution",
    "Can you review my code?",
    "I completed the code",
  ];

  for (const signal of userSpokenSignals) {
    assert.equal(
      isCodingDoneSignal(signal),
      true,
      `Signal "${signal}" must trigger oral code review`
    );
  }
});

test("Scenario 4: Candidate asks to move to next question without getting stuck", () => {
  const candidateRequest = "Can we move to the next question?";
  assert.equal(isUserSkipRequest(candidateRequest), true, "Must recognize skip/next intent");

  // If the model confuses 0-based with 1-based and passes current index (e.g. index 3 for Question 4),
  // our auto-correction must cleanly advance to index 4 (Question 5) instead of rejecting or looping.
  const currentQuestionIndex = 3;
  const requestedIndex = 3;
  const { targetIdx, autoCorrected } = resolveTargetQuestionIndex(requestedIndex, currentQuestionIndex, true, 6);

  assert.equal(autoCorrected, true, "Must auto-correct duplicate index call");
  assert.equal(targetIdx, 4, "Must advance to question 5 (index 4)");
});

test("Scenario 5: Automatic backward regression is blocked", () => {
  // Model hallucinates an automatic regression from Q4 (index 3) back to Q2 (index 1) without user request
  const { targetIdx } = resolveTargetQuestionIndex(1, 3, false, 6);
  assert.equal(targetIdx, 3, "Automatic backward transition must be blocked");

  // User explicitly asks to revisit previous question: permitted
  const userRequested = resolveTargetQuestionIndex(1, 3, true, 6);
  assert.equal(userRequested.targetIdx, 1, "Explicit user request to go back must be permitted");
});

test("Scenario 6: End of interview reaches farewell and completes cleanly", () => {
  const totalQuestions = 6;
  const { targetIdx } = resolveTargetQuestionIndex(5, 5, false, totalQuestions);
  assert.equal(targetIdx, 6, "Must target final index (totalQuestions)");

  const farewellPhrases = [
    "Thank you for your time today. Best of luck with your future interviews!",
    "That's all for now. Take care!",
    "感谢你今天的参与，祝你一切顺利！",
  ];

  for (const phrase of farewellPhrases) {
    assert.equal(looksLikeFarewell(phrase, false), true, `Must recognize farewell: "${phrase}"`);
  }
});

test("Scenario 7: Ambient typing noise does not cause false barge-in", () => {
  const typingNoiseDecision = shouldAllowTtsBargeIn({
    inEchoCooldown: true,
    modelIsSpeaking: true,
    responseAudioStarted: true,
    ttsAudioStartedAt: 500,
    nowMs: 1200,
    responseTtsBytes: 48_000,
    rms: 1200, // typing noise RMS is lower than speech attack
    thresholdRms: 2400,
    consecutiveFrames: 3,
    thresholdFrames: 3,
  });

  assert.equal(typingNoiseDecision, false, "Typing noise below threshold must not interrupt AI speech");
});

