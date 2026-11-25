import assert from "node:assert/strict";
import test from "node:test";

import {
  isWhisperHallucination,
  shouldAllowTtsBargeIn,
  stripAssistantEcho,
  isRepeatOrClarificationRequest,
} from "../server/openai-voice-relay-helpers";

test("identifies Whisper silence hallucinations correctly", () => {
  assert.equal(isWhisperHallucination("Okay. Thank you. Bye."), true);
  assert.equal(isWhisperHallucination("Thank you for watching."), true);
  assert.equal(isWhisperHallucination("Bye-bye.Bye-bye."), true);
  assert.equal(isWhisperHallucination("You're being recorded.I'll see you soon."), true);
  assert.equal(isWhisperHallucination("I'll see you in a couple more minutes."), true);
  assert.equal(isWhisperHallucination("So, I'll try to complete."), true);
  assert.equal(isWhisperHallucination("Anyone else? Thank you. Thank you.I'll change the interview."), true);
  assert.equal(isWhisperHallucination("इसना पड़े वास्त करतो है"), true);
  assert.equal(isWhisperHallucination("Nu cred că funcționează. Să nu stăteam de aia. Să o sânăm."), true);
  assert.equal(isWhisperHallucination("It's handy."), true);
  assert.equal(isWhisperHallucination(""), true);
  assert.equal(isWhisperHallucination("   "), true);
  assert.equal(isWhisperHallucination("..."), true);
  assert.equal(isWhisperHallucination("Okay. Thank you. Bye. Thank you. Bye bye. Bye. Oh, I'm sorry. Yeah. Thank you. Thanks. Thank you. Bye. Bye."), true);
  assert.equal(isWhisperHallucination("Cheers."), true);
  assert.equal(isWhisperHallucination("So thank the Lord."), true);
  assert.equal(isWhisperHallucination("Keep it closing."), true);
  assert.equal(isWhisperHallucination("before is material that lots of it is not."), true);
  assert.equal(isWhisperHallucination("See you tomorrow. Bye."), true);
  assert.equal(isWhisperHallucination("See you then."), true);
  assert.equal(isWhisperHallucination("Yeah, I have used no, you will not see this product."), true);
  assert.equal(isWhisperHallucination("The interview is now over. The assessment will be performed to 100 candidates. Over the next 6 months."), true);
  assert.equal(isWhisperHallucination("Hi, this is Rahul Adme. OpenGitHub for the world, 2018."), true);
  assert.equal(isWhisperHallucination("All right. Okay."), true);
  assert.equal(isWhisperHallucination("It's a little hot in there."), true);
  assert.equal(isWhisperHallucination("because you have to do it somehow in order to use it."), true);
  assert.equal(isWhisperHallucination("This is not going to be happening, okay?"), true);
  assert.equal(isWhisperHallucination("Thank you all very much."), true);
  assert.equal(isWhisperHallucination("and more."), true);
  assert.equal(isWhisperHallucination("and more"), true);
  assert.equal(isWhisperHallucination("and more. Thank you for watching. I'm Steve."), true);
  assert.equal(isWhisperHallucination("cell hyperlinks, admin desktop, rearm menus, main screen page, administrative packages,"), true);
  assert.equal(isWhisperHallucination("etc."), true);
  assert.equal(isWhisperHallucination("etc"), true);
  assert.equal(isWhisperHallucination("Thank you for watching!"), true);
  assert.equal(isWhisperHallucination("much."), true);
  assert.equal(isWhisperHallucination("always."), true);
  assert.equal(isWhisperHallucination("Please see the complete disclaimer at https://sites.google.com"), true);
  assert.equal(isWhisperHallucination("visit our website at www.example.com for more info"), true);
  assert.equal(isWhisperHallucination("Terms of service and privacy policy apply"), true);
  assert.equal(isWhisperHallucination("How do you handle alternative cosplay element? How do you deal with the different aspects of the cosplay environment"), true);
  assert.equal(isWhisperHallucination("Next slide please.And of course, without sanity, we would be brain-dead right here."), true);
  assert.equal(isWhisperHallucination("and I'm going to take up the whole floor. Thank you very much.Microsoft Office Word Document MSWordDoc Word.Document.8"), true);
  assert.equal(isWhisperHallucination("in Amish in Amish in Amish in Amish"), true);
  assert.equal(isWhisperHallucination("Q&A"), true);
  assert.equal(isWhisperHallucination("Thank you. Bye. Bye."), true);
  assert.equal(isWhisperHallucination("Bye! Bye!"), true);
  assert.equal(isWhisperHallucination("Thank you. Bye."), true);
});

test("preserves valid user speech transcripts", () => {
  assert.equal(isWhisperHallucination("Can you hear me?"), false);
  assert.equal(isWhisperHallucination("Hello."), false);
  assert.equal(isWhisperHallucination("Hello. Hello."), false);
  assert.equal(isWhisperHallucination("can you hear me"), false);
  assert.equal(isWhisperHallucination("Yes, I can hear you loud and clear."), false);
  assert.equal(isWhisperHallucination("In cybersecurity, artificial intelligence detects threats."), false);
  assert.equal(isWhisperHallucination("Hello, my name is Alex and I am ready."), false);
  assert.equal(isWhisperHallucination("I have experience working with AI-powered features, particularly in security-focused applications and automated monitoring."), false);
  assert.equal(isWhisperHallucination("I have given a minimum of 5 seconds gap between each API call so that I can verify that it is a little safe"), false);
  assert.equal(isWhisperHallucination("The accuracy didn't increase much. We'll come back to that."), false);
  assert.equal(isWhisperHallucination("we can implement both of those operations"), false);
});

test("does not allow TTS barge-in before assistant audio has actually started", () => {
  assert.equal(
    shouldAllowTtsBargeIn({
      inEchoCooldown: true,
      modelIsSpeaking: true,
      responseAudioStarted: false,
      ttsAudioStartedAt: 0,
      nowMs: 1000,
      responseTtsBytes: 0,
      rms: 3000,
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    }),
    false,
  );
});

test("does not allow TTS barge-in until enough assistant audio has been delivered", () => {
  assert.equal(
    shouldAllowTtsBargeIn({
      inEchoCooldown: true,
      modelIsSpeaking: true,
      responseAudioStarted: true,
      ttsAudioStartedAt: 900,
      nowMs: 1200,
      responseTtsBytes: 20_000,
      rms: 3000,
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    }),
    false,
  );
});

test("allows TTS barge-in only after sustained strong speech once assistant audio is underway", () => {
  assert.equal(
    shouldAllowTtsBargeIn({
      inEchoCooldown: true,
      modelIsSpeaking: true,
      responseAudioStarted: true,
      ttsAudioStartedAt: 500,
      nowMs: 1100,
      responseTtsBytes: 48_000,
      rms: 3000,
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    }),
    true,
  );
});

test("detects trailing incomplete thought (candidate paused mid-sentence)", () => {
  const { hasTrailingIncompleteThought } = require("../server/openai-voice-relay-helpers");

  // Incomplete thoughts that should grant +3000ms thinking buffer
  assert.equal(hasTrailingIncompleteThought("I used useEffect here because"), true);
  assert.equal(hasTrailingIncompleteThought("We didn't use Redux because..."), true);
  assert.equal(hasTrailingIncompleteThought("The component re-renders, and"), true);
  assert.equal(hasTrailingIncompleteThought("I structured the state so"), true);
  assert.equal(hasTrailingIncompleteThought("The data is cached, which"), true);
  assert.equal(hasTrailingIncompleteThought("We can handle errors with"), true);
  assert.equal(hasTrailingIncompleteThought("I tried to optimize it, but"), true);
  assert.equal(hasTrailingIncompleteThought("It checks whether"), false); // 'whether' is not in basic trailing set
  assert.equal(hasTrailingIncompleteThought("The reason is that"), true);
  assert.equal(hasTrailingIncompleteThought("We could use localStorage or"), true);
  assert.equal(hasTrailingIncompleteThought("In production, since"), true);
  assert.equal(hasTrailingIncompleteThought("We poll the server while"), true);

  // Complete answers that should NOT delay transition
  assert.equal(hasTrailingIncompleteThought("I used useEffect to fetch the user profile."), false);
  assert.equal(hasTrailingIncompleteThought("That was our main architecture approach."), false);
  assert.equal(hasTrailingIncompleteThought("We chose PostgreSQL."), false);
  assert.equal(hasTrailingIncompleteThought(""), false);
});

test("detects candidate spoken coding completion signal", () => {
  const { isCodingDoneSignal } = require("../server/openai-voice-relay-helpers");

  assert.equal(isCodingDoneSignal("I'm done"), true);
  assert.equal(isCodingDoneSignal("I am done with the code"), true);
  assert.equal(isCodingDoneSignal("I finished"), true);
  assert.equal(isCodingDoneSignal("That's my solution"), true);
  assert.equal(isCodingDoneSignal("That's all"), true);
  assert.equal(isCodingDoneSignal("I completed the code"), true);
  assert.equal(isCodingDoneSignal("Can you check my code?"), true);
  assert.equal(isCodingDoneSignal("Please review my code"), true);
  assert.equal(isCodingDoneSignal("Take a look at my code"), true);

  // Not done
  assert.equal(isCodingDoneSignal("I am typing the function"), false);
  assert.equal(isCodingDoneSignal("What should the return type be?"), false);
});

test("detects general verbal answer completion signals", () => {
  const { isAnswerDoneSignal } = require("../server/openai-voice-relay-helpers");

  assert.equal(isAnswerDoneSignal("That's my answer"), true);
  assert.equal(isAnswerDoneSignal("That's all"), true);
  assert.equal(isAnswerDoneSignal("That is pretty much it"), true);
  assert.equal(isAnswerDoneSignal("I'm done answering"), true);
  assert.equal(isAnswerDoneSignal("I am finished"), true);
  assert.equal(isAnswerDoneSignal("What do you think?"), true);
  assert.equal(isAnswerDoneSignal("Does that make sense?"), true);
  assert.equal(isAnswerDoneSignal("We can move on"), true);
  assert.equal(isAnswerDoneSignal("Ready for the next question"), true);
  assert.equal(isAnswerDoneSignal("That wraps up my answer"), true);
  assert.equal(isAnswerDoneSignal("这就是我的回答"), true);
  assert.equal(isAnswerDoneSignal("我说完了"), true);

  // Still explaining — not done
  assert.equal(isAnswerDoneSignal("In React we use useState to handle local component state."), false);
  assert.equal(isAnswerDoneSignal("Let me think about how to structure this."), false);
});

test("detects audio confirmations and brief greetings to prevent false echo rejection", () => {
  const { isAudioConfirmationOrGreeting } = require("../server/openai-voice-relay-helpers");

  assert.equal(isAudioConfirmationOrGreeting("Can you hear me?"), true);
  assert.equal(isAudioConfirmationOrGreeting("Can you hear me loud and clear?"), true);
  assert.equal(isAudioConfirmationOrGreeting("How can you hear me?"), true);
  assert.equal(isAudioConfirmationOrGreeting("Yes, I can hear you"), true);
  assert.equal(isAudioConfirmationOrGreeting("Loud and clear"), true);
  assert.equal(isAudioConfirmationOrGreeting("Hello"), true);
  assert.equal(isAudioConfirmationOrGreeting("Hi there"), true);
  assert.equal(isAudioConfirmationOrGreeting("Hello. Hey."), true);
  assert.equal(isAudioConfirmationOrGreeting("Hi. Hello."), true);
  assert.equal(isAudioConfirmationOrGreeting("Am I audible?"), true);

  // Long technical answer should not be classified as brief greeting
  assert.equal(
    isAudioConfirmationOrGreeting("React uses a virtual DOM to optimize UI updates by comparing the virtual representation with real DOM"),
    false
  );
});

test("detects candidate skip & next-question navigation requests", () => {
  const { isFastNextRequest, isUserSkipRequest } = require("../server/openai-voice-relay-helpers");

  // Fast next
  assert.equal(isFastNextRequest("next question"), true);
  assert.equal(isFastNextRequest("skip"), true);
  assert.equal(isFastNextRequest("下一题"), true);

  // Conversational skip / move on
  assert.equal(isUserSkipRequest("Can we move to the next question?"), true);
  assert.equal(isUserSkipRequest("Let's move on to the next topic"), true);
  assert.equal(isUserSkipRequest("Please skip this question"), true);
  assert.equal(isUserSkipRequest("I'd like to skip this one"), true);
  assert.equal(isUserSkipRequest("I don't know the answer, can we move on?"), true);

  // Negative tests (should not trigger accidental skip)
  assert.equal(isUserSkipRequest("In my next project, I handled authentication."), false);
  assert.equal(isUserSkipRequest("We used skip-list data structures."), false);
});

test("detects candidate previous-question requests", () => {
  const { isFastPrevRequest, isUserPrevRequest } = require("../server/openai-voice-relay-helpers");

  assert.equal(isFastPrevRequest("previous question"), true);
  assert.equal(isFastPrevRequest("上一题"), true);

  assert.equal(isUserPrevRequest("Can we go back to the previous question?"), true);
  assert.equal(isUserPrevRequest("I want to revisit the previous question"), true);
  assert.equal(isUserPrevRequest("Let's return to the last problem"), true);

  // Negative test
  assert.equal(isUserPrevRequest("In my previous role, I was a frontend lead."), false);
});

test("auto-corrects duplicate question index and guards backward transitions", () => {
  const { resolveTargetQuestionIndex } = require("../server/openai-voice-relay-helpers");

  // Bug reproduction: Model passes current index (3) on Q4: must auto-advance to Q5 (index 4)
  const q4Advance = resolveTargetQuestionIndex(3, 3, true, 6);
  assert.equal(q4Advance.targetIdx, 4);
  assert.equal(q4Advance.autoCorrected, true);

  // Automatic backward transition blocked
  const autoBackward = resolveTargetQuestionIndex(1, 3, false, 6);
  assert.equal(autoBackward.targetIdx, 3); // stays on current question

  // Explicit user-requested backward transition permitted
  const userBackward = resolveTargetQuestionIndex(1, 3, true, 6);
  assert.equal(userBackward.targetIdx, 1);

  // Clean transition to interview end
  const finalAdvance = resolveTargetQuestionIndex(5, 5, true, 6);
  assert.equal(finalAdvance.targetIdx, 6);
});

test("detects farewell and interview closure patterns", () => {
  const { looksLikeFarewell, isCandidateWrapUpRequest } = require("../server/openai-voice-relay-helpers");

  assert.equal(looksLikeFarewell("Thank you for your time today. Best of luck going forward!", false), true);
  assert.equal(looksLikeFarewell("That's all for now. Take care and good luck with future interviews!", false), true);
  assert.equal(looksLikeFarewell("Sounds good! Thanks for your time today. If you have any follow-up questions later, feel free to reach out. Have a great day!", false), true);
  assert.equal(looksLikeFarewell("感谢你今天的参与，祝你一切顺利！", true), true);

  // Candidate wrap up requests
  assert.equal(isCandidateWrapUpRequest("So, then we can wrap it up."), true);
  assert.equal(isCandidateWrapUpRequest("Close the interview then"), true);
  assert.equal(isCandidateWrapUpRequest("we can wrap up here"), true);
  assert.equal(isCandidateWrapUpRequest("我们可以结束面试了"), true);

  // Negative tests
  assert.equal(looksLikeFarewell("How do you typically manage time?", false), false);
  assert.equal(looksLikeFarewell("Is this all for today?", false), false); // question mark
  assert.equal(isCandidateWrapUpRequest("I can wrap this function in a try-catch block."), false);
});

test("merges ASR transcript chunks cleanly without regressing", () => {
  const { mergeAsrText } = require("../server/openai-voice-relay-helpers");

  // Incremental expansion
  assert.equal(mergeAsrText("I used", "I used React"), "I used React");
  assert.equal(mergeAsrText("I used React", "I used React hooks for state"), "I used React hooks for state");

  // Whisper trailing noise fragment does NOT wipe out full sentence
  assert.equal(
    mergeAsrText("We implemented Redis caching with a five minute TTL to avoid cache stampede.", "TTL"),
    "We implemented Redis caching with a five minute TTL to avoid cache stampede."
  );
});

test("proctoring disruption: suppresses looking_away during coding, disrupts on other violations", () => {
  const { shouldDisruptForProctorAlert, buildProctorWarningText } = require("../server/openai-voice-relay-helpers");

  const baseTime = 1_000_000;

  // 1. Looking away during coding MUST be suppressed
  const lookingAwayDuringCoding = shouldDisruptForProctorAlert({
    alertType: "looking_away",
    isCoding: true,
    nowMs: baseTime,
    lastProctorSpokenAt: 0,
    lastTypeSpokenAt: 0,
  });
  assert.equal(lookingAwayDuringCoding.shouldDisrupt, false);
  assert.equal(lookingAwayDuringCoding.reason, "suppressed_during_coding");

  // 2. Looking away during conceptual question MUST disrupt
  const lookingAwayNonCoding = shouldDisruptForProctorAlert({
    alertType: "looking_away",
    isCoding: false,
    nowMs: baseTime,
    lastProctorSpokenAt: 0,
    lastTypeSpokenAt: 0,
  });
  assert.equal(lookingAwayNonCoding.shouldDisrupt, true);

  // 3. Face missing during coding MUST disrupt (integrity preserved)
  const faceMissingDuringCoding = shouldDisruptForProctorAlert({
    alertType: "face_missing",
    isCoding: true,
    nowMs: baseTime,
    lastProctorSpokenAt: 0,
    lastTypeSpokenAt: 0,
  });
  assert.equal(faceMissingDuringCoding.shouldDisrupt, true);

  // 4. Multiple faces detected MUST disrupt
  const multipleFaces = shouldDisruptForProctorAlert({
    alertType: "multiple_faces",
    isCoding: true,
    nowMs: baseTime,
    lastProctorSpokenAt: 0,
    lastTypeSpokenAt: 0,
  });
  assert.equal(multipleFaces.shouldDisrupt, true);

  // 5. Page departure / tab switch MUST disrupt
  const pageDeparture = shouldDisruptForProctorAlert({
    alertType: "page_departure",
    isCoding: true,
    nowMs: baseTime,
    lastProctorSpokenAt: 0,
    lastTypeSpokenAt: 0,
  });
  assert.equal(pageDeparture.shouldDisrupt, true);

  // 6. Global cooldown suppresses disruption if another alert spoke 5 seconds ago
  const inGlobalCooldown = shouldDisruptForProctorAlert({
    alertType: "multiple_faces",
    isCoding: false,
    nowMs: baseTime + 5_000,
    lastProctorSpokenAt: baseTime,
    lastTypeSpokenAt: 0,
  });
  assert.equal(inGlobalCooldown.shouldDisrupt, false);
  assert.equal(inGlobalCooldown.reason, "global_cooldown");

  // 7. Per-type cooldown suppresses disruption if the same alert occurred 15 seconds ago
  const inTypeCooldown = shouldDisruptForProctorAlert({
    alertType: "face_missing",
    isCoding: false,
    nowMs: baseTime + 15_000,
    lastProctorSpokenAt: baseTime - 20_000, // global is clear
    lastTypeSpokenAt: baseTime, // type was 15s ago, < 20s
  });
  assert.equal(inTypeCooldown.shouldDisrupt, false);
  assert.equal(inTypeCooldown.reason, "type_cooldown");

  // 8. Warning texts generated accurately in English and Chinese
  const enFaceMissing = buildProctorWarningText("face_missing", false);
  assert.match(enFaceMissing, /no longer see your face on camera/i);

  const zhFaceMissing = buildProctorWarningText("face_missing", true);
  assert.match(zhFaceMissing, /检测不到您的面部/);

  const enPageDep = buildProctorWarningText("page_departure", false);
  assert.match(enPageDep, /navigated away from the interview/i);

  const enMultiFace = buildProctorWarningText("multiple_faces", false);
  assert.match(enMultiFace, /multiple faces/i);
});

test("strips assistant echo from candidate speech transcripts", () => {
  const assistantUtterance =
    "No problem at all, that's helpful context. Could you share an example of a project where you combined both—like integrating a data processing component into a web service?";
  
  // 1. Candidate audio begins with the exact echo of Sarah's question followed by candidate's answer
  const mixedTranscript =
    "No problem at all. That's helpful context. Could you share an example of a project where you combined both? Like integrating a data processing component into a web service? Let me just pick a clear one for you. Sure. One project was a data reporting API.";
  
  const result = stripAssistantEcho(mixedTranscript, [assistantUtterance]);
  assert.equal(result.isFullEcho, false);
  assert.equal(
    result.cleanedText,
    "Let me just pick a clear one for you. Sure. One project was a data reporting API."
  );

  // 2. Candidate audio is 100% echo of Sarah's question
  const fullEcho =
    "No problem at all, that's helpful context. Could you share an example of a project where you combined both—like integrating a data processing component into a web service?";
  const fullResult = stripAssistantEcho(fullEcho, [assistantUtterance]);
  assert.equal(fullResult.isFullEcho, true);
  assert.equal(fullResult.cleanedText, "");

  // 3. Genuine user answer that starts differently is preserved intact
  const realAnswer =
    "Sure, I built a data pipeline using FastAPI and Pandas to ingest CSV files.";
  const realResult = stripAssistantEcho(realAnswer, [assistantUtterance]);
  assert.equal(realResult.isFullEcho, false);
  assert.equal(realResult.cleanedText, realAnswer);
});

test("detects repeat or clarification requests from candidate", () => {
  assert.equal(isRepeatOrClarificationRequest("Can you repeat that?"), true);
  assert.equal(isRepeatOrClarificationRequest("Could you repeat the question?"), true);
  assert.equal(isRepeatOrClarificationRequest("What was the question?"), true);
  assert.equal(isRepeatOrClarificationRequest("Say that again?"), true);
  assert.equal(isRepeatOrClarificationRequest("Sorry, didn't catch that"), true);
  assert.equal(isRepeatOrClarificationRequest("Pardon?"), true);
  assert.equal(isRepeatOrClarificationRequest("请再说一遍"), true);
  assert.equal(isRepeatOrClarificationRequest("I used FastAPI and PostgreSQL for the backend"), false);
});
