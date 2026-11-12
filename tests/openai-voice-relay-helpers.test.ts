import assert from "node:assert/strict";
import test from "node:test";

import { isWhisperHallucination, shouldAllowTtsBargeIn } from "../server/openai-voice-relay-helpers";

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
});

test("preserves valid user speech transcripts", () => {
  assert.equal(isWhisperHallucination("Can you hear me?"), false);
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
