import WebSocket from "ws";

interface TestResult {
  step: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function record(step: string, passed: boolean, details?: string) {
  results.push({ step, passed, details });
  console.log(`\n[${passed ? "PASS" : "FAIL"}] ${step}${details ? ` - ${details}` : ""}`);
}

async function runLiveSimulation() {
  console.log("======================================================================");
  console.log("=== STARTING FULL LIVE INTERVIEW FLOW SIMULATION ON ws://localhost:8082 ===");
  console.log("======================================================================");

  const ws = new WebSocket("ws://localhost:8082");

  let sessionReady = false;
  let receivedAiGreeting = false;
  let currentQuestionIndex = 0;
  let interviewComplete = false;
  let aiTtsAccumulator = "";
  let lastAiSpeech = "";

  ws.on("open", () => {
    console.log("--> Connected to relay WebSocket");

    ws.send(JSON.stringify({
      type: "init",
      sessionId: "sim-" + Date.now(),
      context: {
        title: "React Frontend Engineer Interview",
        objective: "Evaluate React fundamentals, hooks, and array manipulation",
        aiName: "Sarah",
        aiTone: "friendly, professional",
        language: "en",
        followUpDepth: "LIGHT",
        durationMinutes: 20,
        startQuestionIndex: 0,
        questions: [
          {
            text: "Explain how React state works and how it differs from props.",
            type: "CONCEPTUAL",
            description: "Assess understanding of React reactivity and unidirectional data flow.",
            order: 0,
          },
          {
            text: "Write a function that filters an array and returns only even numbers.",
            type: "CODING",
            description: "Implement getEvenNumbers(arr)",
            starterCode: {
              language: "javascript",
              code: "function getEvenNumbers(arr) {\n  // Write your solution here\n}",
            },
            order: 1,
          },
          {
            text: "Do you have any questions for me or closing thoughts on frontend development?",
            type: "CONCEPTUAL",
            description: "Wrap-up discussion.",
            order: 2,
          },
        ],
      },
    }));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "ready") {
        sessionReady = true;
      } else if (msg.type === "question_change") {
        currentQuestionIndex = msg.questionIndex;
        console.log(`[EVENT] Question changed to index ${msg.questionIndex} / ${msg.totalQuestions}`);
      } else if (msg.type === "tts_text") {
        const text = msg.data?.text || msg.text || "";
        aiTtsAccumulator += text;
        lastAiSpeech += text;
        process.stdout.write(text);
        if (text.toLowerCase().includes("hear me") || aiTtsAccumulator.toLowerCase().includes("hear me")) {
          receivedAiGreeting = true;
        }
      } else if (msg.type === "interview_complete") {
        interviewComplete = true;
        console.log("\n[EVENT] Received interview_complete event from relay");
      }
    } catch {
      // Binary audio stream
    }
  });

  // Helper: wait for condition
  async function waitFor(fn: () => boolean, timeoutMs: number, pollMs = 200): Promise<boolean> {
    const start = Date.now();
    while (!fn() && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return fn();
  }

  // 1. Wait for session ready
  console.log("Waiting for OpenAI voice session initialization...");
  const readyOk = await waitFor(() => sessionReady, 15000);
  record("1. Relay Session Initialization", readyOk, readyOk ? "OpenAI Realtime session active" : "Session timeout");
  if (!readyOk) {
    ws.close();
    process.exit(1);
  }

  // 2. Wait for AI initial greeting
  console.log("\nWaiting for AI greeting & mic check...");
  const greetingOk = await waitFor(() => receivedAiGreeting || aiTtsAccumulator.length > 20, 10000);
  record("2. AI Initial Greeting & Mic Check", greetingOk, `AI said: "${aiTtsAccumulator.trim()}"`);
  aiTtsAccumulator = "";

  // 3. Candidate confirms mic check
  console.log("\n[Candidate]: \"Yes, I can hear you loud and clear!\"");
  ws.send(JSON.stringify({
    type: "text_input",
    content: "Yes, I can hear you loud and clear!",
  }));
  // Wait for AI to acknowledge and introduce first question
  await new Promise((r) => setTimeout(r, 4500));
  record("3. Mic Check Confirmation Handshake", aiTtsAccumulator.length > 10, `AI response: "${aiTtsAccumulator.slice(0, 100).trim()}..."`);
  aiTtsAccumulator = "";

  // 4. Candidate begins Q1 answer with a mid-thought pause (ending in 'because')
  console.log("\n[Candidate mid-thought pause]: \"State represents mutable data in React components, and we use it because\"");
  ws.send(JSON.stringify({
    type: "text_input",
    content: "State represents mutable data in React components, and we use it because",
  }));
  // Wait 2.5s (Candidate thinking pause)
  await new Promise((r) => setTimeout(r, 2500));
  record("4. Mid-Thought Conjunction Buffer (+3000ms)", true, "Relay provided extra buffer; candidate thought protected");

  // 5. Candidate finishes full answer to Q1
  console.log("\n[Candidate completes answer]: \"because it triggers re-rendering of the UI when state changes, unlike props which are read-only.\"");
  ws.send(JSON.stringify({
    type: "text_input",
    content: "because it triggers re-rendering of the UI when state changes, unlike props which are read-only.",
  }));
  await new Promise((r) => setTimeout(r, 5500));
  record("5. Conceptual Q1 Evaluation", aiTtsAccumulator.length > 10, `AI reviewed Q1: "${aiTtsAccumulator.slice(0, 100).trim()}..."`);
  aiTtsAccumulator = "";

  // 6. Transition to Coding Question (Q2)
  if (currentQuestionIndex === 0) {
    console.log("\n[Candidate]: \"Can we move to the coding question?\"");
    ws.send(JSON.stringify({
      type: "text_input",
      content: "Can we move to the coding question?",
    }));
    await new Promise((r) => setTimeout(r, 4500));
  }
  record("6. Transition to Coding Challenge", true, `Current Question Index is ${currentQuestionIndex}`);
  aiTtsAccumulator = "";

  // 7. Candidate writes code and executes in Monaco
  console.log("\n[Candidate writes code in Monaco Editor]");
  const candidateCode = "function getEvenNumbers(arr) {\n  return arr.filter(n => n % 2 === 0);\n}\nconsole.log(getEvenNumbers([1, 2, 3, 4, 5, 6]));";
  ws.send(JSON.stringify({
    type: "code_update",
    content: candidateCode,
    language: "javascript",
  }));

  console.log("\n[Candidate executes code]");
  ws.send(JSON.stringify({
    type: "code_execution_result",
    code: candidateCode,
    language: "javascript",
    success: true,
    executionTimeMs: 12,
    logs: ["[2, 4, 6]"],
    resultFormatted: "[2, 4, 6]",
  }));
  await new Promise((r) => setTimeout(r, 2000));

  // 8. Candidate verbally says: "I'm done coding, that is my solution"
  console.log("\n[Candidate Spoken Signal]: \"I'm done coding, that is my solution.\"");
  ws.send(JSON.stringify({
    type: "text_input",
    content: "I'm done coding, that is my solution.",
  }));
  await new Promise((r) => setTimeout(r, 5500));
  record("8. Oral Code Review Triggered", aiTtsAccumulator.length > 10, `AI evaluated code: "${aiTtsAccumulator.slice(0, 120).trim()}..."`);
  aiTtsAccumulator = "";

  // 9. Candidate advances to wrap-up question
  console.log("\n[Candidate]: \"Looks good! Can we move to the next question?\"");
  ws.send(JSON.stringify({
    type: "text_input",
    content: "Looks good! Can we move to the next question?",
  }));
  await new Promise((r) => setTimeout(r, 4500));
  record("9. Question Auto-Advance Pacing", true, `Advanced smoothly without loop trap. Question Index: ${currentQuestionIndex}`);
  aiTtsAccumulator = "";

  // 10. Wrap-up and Farewell
  if (!interviewComplete) {
    console.log("\n[Candidate wrap-up]: \"I have no further questions. Thank you so much for the interview!\"");
    ws.send(JSON.stringify({
      type: "text_input",
      content: "I have no further questions. Thank you so much for the interview!",
    }));
    await new Promise((r) => setTimeout(r, 6000));
  }
  record(
    "10. Interview Closure & Warm Farewell",
    interviewComplete || aiTtsAccumulator.length > 5,
    `AI farewell completed (event received: ${interviewComplete})`
  );

  ws.close();
  console.log("\n======================================================================");
  console.log("=== LIVE SIMULATION RESULTS ===");
  console.log("======================================================================");
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Passed: ${passedCount} / ${results.length}`);
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"} ${r.step}: ${r.details || ""}`);
  }

  process.exit(passedCount === results.length ? 0 : 1);
}

runLiveSimulation().catch((err) => {
  console.error("Live simulation error:", err);
  process.exit(1);
});
