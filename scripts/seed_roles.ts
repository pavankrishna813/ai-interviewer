import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { randomUUID as uuidv4 } from "crypto";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const userId = "57ec15ff-8869-4993-bd1f-483eeeedb031";
const projectId = "f65d5862-444a-4932-9aba-27c3a6a7b23d";

const interviewsData = [
  {
    title: "Backend Python Engineer (FastAPI & Cloud APIs)",
    description: "Evaluates modern Python backend engineering, FastAPI architecture, asynchronous concurrency, Pydantic validation, database ORM integration, and API security.",
    objective: "To assess candidate competence in architecting, developing, and securing scalable asynchronous REST APIs and microservices using FastAPI and Python.",
    aiName: "Sarah (Backend Lead)",
    assessmentCriteria: [
      { name: "FastAPI & Python Architecture", description: "Proficiency in ASGI, async/await, Pydantic models, and framework best practices" },
      { name: "Database & Concurrency", description: "Handling async sessions, connection pools, and relational/NoSQL storage" },
      { name: "API Security & Performance", description: "JWT authentication, rate limiting, error handling, and latency optimization" },
      { name: "Code & Problem Solving", description: "Clean code structure, modular design, and robust API implementation" }
    ],
    questions: [
      {
        order: 0,
        text: "Can you explain the core architectural advantages of FastAPI over traditional frameworks like Flask or Django, particularly regarding ASGI, async/await, and automatic OpenAPI generation?",
        description: "Discuss concurrency, type hinting, and developer experience.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How does Starlette and Pydantic power FastAPI under the hood?",
          "When would an async endpoint actually run slower than a synchronous one if blocking operations are used?"
        ]
      },
      {
        order: 1,
        text: "How do Pydantic models in FastAPI handle request body validation, schema serialization, and field-level constraints? How do you implement custom validation logic?",
        description: "Explain validators, Field constraints, and nested schemas.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What is the difference between field-level and root/model-level validators in Pydantic?",
          "How do you return custom formatted validation error responses to the client?"
        ]
      },
      {
        order: 2,
        text: "In a production microservice, how do you manage database connections and transactional session lifecycles using FastAPI dependency injection (Depends)?",
        description: "Discuss async session management, SQLAlchemy/Tortoise, and resource cleanup.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How does yield in a FastAPI dependency guarantee connection cleanup after response generation?",
          "How do you prevent connection pool exhaustion during traffic spikes?"
        ]
      },
      {
        order: 3,
        text: "Can you write an asynchronous FastAPI endpoint that accepts a query parameter, validates an incoming payload using Pydantic, and returns a processed JSON response with proper HTTP status codes?",
        description: "Implement a clean endpoint with validation and error handling.",
        type: "CODING",
        starterCode: {
          language: "python",
          code: `from fastapi import FastAPI, HTTPException, status\nfrom pydantic import BaseModel, Field\nfrom typing import Optional, List\n\napp = FastAPI()\n\nclass ItemCreate(BaseModel):\n    name: str = Field(..., min_length=2, max_length=50)\n    price: float = Field(..., gt=0)\n    tags: List[str] = []\n\n# Implement your FastAPI route:\n@app.post("/items", status_code=status.HTTP_201_CREATED)\nasync def create_item(item: ItemCreate):\n    # Return formatted response\n    return {"status": "success", "item": item.dict()}\n\n# Test execution\nimport asyncio\nasync def run_test():\n    sample = ItemCreate(name="Server Instance", price=99.50, tags=["cloud", "backend"])\n    res = await create_item(sample)\n    print("Response:", res)\n\nasyncio.run(run_test())\n`
        },
        followUpPrompts: [
          "How would you handle duplicate key conflicts or database integrity errors in this route?",
          "How would you write an automated test for this endpoint using TestClient or httpx?"
        ]
      },
      {
        order: 4,
        text: "How do you implement secure user authentication (JWT tokens, OAuth2 with Password hashing) and background task processing in FastAPI?",
        description: "Discuss security flows, passlib/bcrypt, and BackgroundTasks.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "When should you use FastAPI BackgroundTasks vs an external distributed broker like Celery or Redis Queue?",
          "How do you handle token revocation and refresh token rotation?"
        ]
      },
      {
        order: 5,
        text: "Is there anything else you would like to share about a production API or complex microservice you designed, including any memorable bugs or performance bottlenecks you solved?",
        description: "Feel free to share personal projects, architecture choices, or production lessons.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What monitoring or tracing tools did you integrate?",
          "What would you do differently if rebuilding that system today?"
        ]
      }
    ]
  },
  {
    title: "Frontend React Developer (React 18 & Modern Web)",
    description: "Evaluates practical frontend engineering in React 18, JSX/TSX component architecture, hooks lifecycle, state management, client performance optimization, and responsive UI.",
    objective: "To assess candidate mastery of React components, custom hooks, dynamic rendering, state architecture, and frontend problem-solving.",
    aiName: "Alex (Frontend Architect)",
    assessmentCriteria: [
      { name: "React Core & Architecture", description: "Component composition, hooks lifecycle, and React 18 concurrent features" },
      { name: "State & Data Flow", description: "Local vs global state management, Context API, Redux/Zustand, and caching" },
      { name: "Code Quality & Reactivity", description: "Clean JSX/TSX, maintainable patterns, and TypeScript integration" },
      { name: "Performance & UX", description: "Memoization, bundle splitting, layout stability, and rendering efficiency" }
    ],
    questions: [
      {
        order: 0,
        text: "Can you explain how React 18 concurrent rendering works under the hood, and how features like transitions (useTransition) and automatic batching improve user experience?",
        description: "Discuss virtual DOM diffing, fiber architecture, and UI responsiveness.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How does useTransition differ from standard debouncing or throttling?",
          "What problems does automatic batching solve in asynchronous promise callbacks?"
        ]
      },
      {
        order: 1,
        text: "What are the key trade-offs between useEffect, useMemo, and useCallback? When does unnecessary memoization actually hurt performance instead of helping?",
        description: "Explain dependency arrays, memory allocation, and render lifecycles.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How do closures in useEffect lead to stale state bugs, and how do you resolve them?",
          "In what scenarios would you choose useLayoutEffect instead of useEffect?"
        ]
      },
      {
        order: 2,
        text: "When architecting client-side state in a medium-to-large application, how do you evaluate React Context API versus external stores like Zustand or Redux Toolkit?",
        description: "Discuss prop drilling, unnecessary re-render propagation, and store isolation.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "Why can updating a Context value cause unrelated consuming components to re-render?",
          "How does modern server state caching (TanStack Query / SWR) reduce the need for global client stores?"
        ]
      },
      {
        order: 3,
        text: "Can you write a React component that implements a live search filter with an input field and dynamic list rendering?",
        description: "Create an interactive component managing filter state and rendering matched items.",
        type: "CODING",
        starterCode: {
          language: "javascript",
          code: `import React, { useState } from 'react';\n\nconst ITEMS = [\n  "React Fundamentals",\n  "FastAPI Microservices",\n  "Tailwind CSS Styling",\n  "Next.js App Router",\n  "TypeScript Type Safety",\n  "GraphQL Querying",\n  "PostgreSQL Database"\n];\n\nexport default function SearchFilter() {\n  const [query, setQuery] = useState('');\n\n  const filteredItems = ITEMS.filter(item =>\n    item.toLowerCase().includes(query.toLowerCase())\n  );\n\n  return (\n    <div style={{ fontFamily: 'sans-serif', padding: '16px' }}>\n      <input\n        type="text"\n        placeholder="Filter items..."\n        value={query}\n        onChange={(e) => setQuery(e.target.value)}\n        style={{ padding: '8px', width: '280px', marginBottom: '12px' }}\n      />\n      <ul>\n        {filteredItems.map((item, idx) => (\n          <li key={idx} style={{ padding: '4px 0' }}>{item}</li>\n        ))}\n      </ul>\n      {filteredItems.length === 0 && <p style={{ color: '#888' }}>No matches found.</p>}\n    </div>\n  );\n}\n`
        },
        followUpPrompts: [
          "How would you optimize this if ITEMS contained 50,000 records?",
          "How would you debounce the search input to prevent expensive filtering on every keystroke?"
        ]
      },
      {
        order: 4,
        text: "How do you handle common frontend resilience requirements like Error Boundaries, code splitting with React.lazy and Suspense, and accessibility (ARIA standards)?",
        description: "Discuss defensive frontend architecture and accessible UI practices.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "Why can't standard functional components catch rendering errors without a class Error Boundary or package wrapper?",
          "How do you ensure keyboard navigation and screen reader compatibility across custom dropdowns or modals?"
        ]
      },
      {
        order: 5,
        text: "Is there a frontend project, design system integration, or challenging performance bug you solved that you would like to share?",
        description: "Discuss architecture decisions, team workflows, or notable frontend achievements.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What metrics (e.g. Core Web Vitals, LCP, INP) did you monitor to verify your improvements?",
          "What is your philosophy on testing React applications?"
        ]
      }
    ]
  },
  {
    title: "Data & Operations Analyst (Advanced Excel & Business Analytics)",
    description: "Evaluates advanced Excel capabilities, dynamic array functions, Power Query automation, financial & scenario modeling, Pivot Table analytics, and data validation.",
    objective: "To evaluate candidate aptitude in organizing raw data, engineering automated spreadsheet models, performing variance analysis, and delivering actionable business insights.",
    aiName: "Elena (Operations Analytics Lead)",
    assessmentCriteria: [
      { name: "Advanced Formulas & Functions", description: "Proficiency in XLOOKUP, dynamic arrays (FILTER, UNIQUE, LET), and nested logical functions" },
      { name: "Data Modeling & Power Query", description: "Automating ETL, data sanitization, relationship modeling, and Power Pivot" },
      { name: "Business Problem Solving", description: "Translating messy operational data into executive KPIs and scenario forecasting" },
      { name: "Communication & Visualization", description: "Explaining analytical findings, dashboard structuring, and data integrity safeguards" }
    ],
    questions: [
      {
        order: 0,
        text: "Can you compare XLOOKUP versus the classic INDEX/MATCH and VLOOKUP? In what real-world modeling situations would you specifically choose one over the others?",
        description: "Discuss lookup directions, performance on 100k+ rows, handling missing values, and two-way matrix lookups.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How does XLOOKUP handle search direction and binary search for sorted lists?",
          "What risks does VLOOKUP introduce when columns are inserted or deleted in a collaborative sheet?"
        ]
      },
      {
        order: 1,
        text: "How do you leverage modern Excel dynamic array functions like FILTER, UNIQUE, SORT, and the LET function to construct self-updating dashboard summaries without VBA?",
        description: "Explain spill ranges, calculation speed, formula readability, and variable naming using LET.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How does the LET function prevent redundant formula evaluations and speed up workbook calculation?",
          "What causes a #SPILL! error and how do you resolve it programmatically?"
        ]
      },
      {
        order: 2,
        text: "Can you walk me through your workflow using Power Query to automate the extraction, transformation, and recurring cleaning of messy multi-source data?",
        description: "Discuss unpivoting columns, handling date format discrepancies, merging queries, and one-click refresh.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What is the difference between merging queries and appending queries in Power Query?",
          "How do you parameterize folder paths in Power Query so multiple teammates can refresh without errors?"
        ]
      },
      {
        order: 3,
        text: "Scenario: Your company has 10,000 monthly transactions across four regions with inconsistent date formats, missing customer IDs, and duplicate entries. Walk me through your step-by-step audit to clean this data and calculate month-over-month regional growth.",
        description: "Demonstrate practical analytical methodology and data integrity hygiene.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What formula or feature would you use to flag duplicate records based on multiple matching columns?",
          "How would you verify whether growth was driven by transaction volume vs average order value?"
        ]
      },
      {
        order: 4,
        text: "How do you construct financial sensitivity models or what-if scenarios using Data Tables, Scenario Manager, or Goal Seek? How do you safeguard model integrity against accidental tampering?",
        description: "Discuss 1-variable and 2-variable data tables, cell protection, and data validation rules.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How do you implement dynamic dropdown menus using Data Validation with dependent lists (INDIRECT)?",
          "What precautions do you take before sharing a complex model with non-technical executive stakeholders?"
        ]
      },
      {
        order: 5,
        text: "Could you share an example of the most impactful spreadsheet model or dashboard you built, the business problem it tackled, and what insights leadership gained from it?",
        description: "Discuss business context, automation impact, and quantitative outcomes.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How many hours of manual effort did your model eliminate for the team?",
          "If you were to migrate that model to Python or SQL, what would be the deciding factors?"
        ]
      }
    ]
  },
  {
    title: "Product & UI/UX Designer (Design Systems & User Research)",
    description: "Evaluates end-to-end product design: user research, wireframing, interactive prototyping in Figma, design system architecture, accessibility (WCAG), and developer handoff.",
    objective: "To assess candidate capabilities in designing intuitive digital experiences, validating user needs, organizing design systems, and driving product metrics.",
    aiName: "Jordan (Lead Product Designer)",
    assessmentCriteria: [
      { name: "Design Thinking & Research", description: "User journey mapping, research synthesis, problem framing, and usability testing" },
      { name: "UI Craft & Figma Mastery", description: "Visual hierarchy, typography, auto-layout, component variants, and prototyping" },
      { name: "Design System Scalability", description: "Token architecture, component governance, WCAG accessibility, and consistency" },
      { name: "Product Strategy & Handoff", description: "Balancing user needs with business goals, engineering handoff, and metrics analysis" }
    ],
    questions: [
      {
        order: 0,
        text: "Can you walk me through your end-to-end design process when given a vague business objective or an unvalidated feature request from stakeholders?",
        description: "Discuss discovery, problem framing, user interviews, wireframing, and iterative testing.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How do you push back or realign when a stakeholder insists on a specific solution before understanding user pain points?",
          "What artifacts (e.g. persona, journey map, service blueprint) do you find most valuable during discovery?"
        ]
      },
      {
        order: 1,
        text: "How do you balance qualitative feedback (usability test observations, customer interviews) with quantitative product analytics (drop-off rates, heatmaps, conversion funnels)?",
        description: "Explain how you identify the 'what' versus the 'why' behind user behavior.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "Can you share an instance where analytics showed a metric drop, but user interviews revealed an unexpected underlying reason?",
          "How do you design an effective unmoderated usability test script without biasing participant actions?"
        ]
      },
      {
        order: 2,
        text: "How do you structure and maintain a scalable Design System in Figma? Walk me through how you organize design tokens, component variants, Auto Layout, and responsive breakpoints.",
        description: "Discuss color/typography tokens, component states, and documentation.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How do you ensure accessibility standards (such as WCAG 2.1 AA contrast ratios and target touch sizes) are baked into design tokens?",
          "How do you handle breaking updates in a shared component library used across multiple product teams?"
        ]
      },
      {
        order: 3,
        text: "Scenario: Product analytics reveal a 55% user drop-off on a mobile checkout/onboarding flow. What is your structured framework to diagnose the friction points and design an improved experience?",
        description: "Demonstrate heuristic evaluation, cognitive load reduction, and iterative design solutions.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How do you balance requesting necessary user data with minimizing cognitive load and friction?",
          "What A/B testing hypotheses would you propose to measure the success of your redesign?"
        ]
      },
      {
        order: 4,
        text: "How do you facilitate seamless developer handoff and ongoing collaboration with engineers to ensure design fidelity without creating bottlenecks?",
        description: "Discuss design specs, Figma Dev Mode / Code Connect, edge case coverage, and compromise on technical constraints.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How do you document empty states, loading skeletons, error toasts, and edge cases for frontend developers?",
          "How do you handle situations where an engineer says a proposed design is too expensive or complex to build within the sprint?"
        ]
      },
      {
        order: 5,
        text: "Could you walk me through a key project from your design portfolio—highlighting the initial problem, your design iterations, and the measured impact on user engagement or business metrics?",
        description: "Share context, visual craft decisions, stakeholder alignment, and measurable results.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What was the most difficult design trade-off you had to make on that project?",
          "What would you improve if you were to redesign that experience today?"
        ]
      }
    ]
  },
  {
    title: "Mobile Application Developer (React Native & Cross-Platform)",
    description: "Evaluates cross-platform mobile engineering: React Native architecture, native bridges/TurboModules, 60fps performance, offline-first sync, push notifications, and app store deployment.",
    objective: "To evaluate candidate competence in building, profiling, and deploying reliable cross-platform mobile apps for iOS and Android.",
    aiName: "Marcus (Mobile Engineering Lead)",
    assessmentCriteria: [
      { name: "Mobile Architecture & React Native", description: "Fabric renderer, TurboModules, navigation patterns, and native bridging" },
      { name: "Performance & Animation", description: "UI thread offloading, Reanimated, FlashList virtualization, and memory profiling" },
      { name: "Data & Device Capabilities", description: "Offline caching, background push notifications, hardware permissions, and SQLite" },
      { name: "Store Operations & Release", description: "CodePush/EAS updates, App Store/Play Store review compliance, and crash analytics" }
    ],
    questions: [
      {
        order: 0,
        text: "Can you explain the architectural evolution of React Native, specifically comparing the legacy bridge to the New Architecture (Fabric renderer, TurboModules, and Codegen)?",
        description: "Discuss JSI (JavaScript Interface), synchronous C++ bindings, and threading models.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How does JSI eliminate JSON serialization bottlenecks between JavaScript and native platforms?",
          "What challenges do development teams face when migrating an existing app to the New Architecture?"
        ]
      },
      {
        order: 1,
        text: "How do you achieve stutter-free 60fps animations and complex gesture interactions in a mobile app without dropping frames on the JavaScript thread?",
        description: "Discuss React Native Reanimated, Gesture Handler, worklets, and native driver limitations.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What is a 'worklet' in Reanimated, and how does it execute on the UI thread?",
          "Why is FlashList or FlatList optimization critical when rendering heavy media feeds on budget Android devices?"
        ]
      },
      {
        order: 2,
        text: "How do you architect an offline-first mobile application, including local persistence (MMKV, WatermelonDB, or SQLite), network connectivity listeners, and background sync queues?",
        description: "Discuss optimistic updates, conflict resolution, and battery-efficient synchronization.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "How do you handle conflict resolution when a user edits data offline that was updated on the server by someone else?",
          "Why is MMKV preferred over standard AsyncStorage for synchronous key-value storage?"
        ]
      },
      {
        order: 3,
        text: "Can you write a reusable React Native hook or component that monitors network connection state and displays a non-intrusive offline banner with a retry action?",
        description: "Implement a clean status listener handling connection state transitions.",
        type: "CODING",
        starterCode: {
          language: "javascript",
          code: `import React, { useState, useEffect } from 'react';\n\n// Simulated Network Info hook\nexport function useNetworkStatus() {\n  const [isConnected, setIsConnected] = useState(true);\n  const toggleConnection = () => setIsConnected(prev => !prev);\n  return { isConnected, toggleConnection };\n}\n\nexport default function OfflineNotice() {\n  const { isConnected, toggleConnection } = useNetworkStatus();\n\n  if (isConnected) {\n    return (\n      <div style={{ padding: '16px', fontFamily: 'sans-serif' }}>\n        <p style={{ color: 'green' }}>✓ Online - Connected to server</p>\n        <button onClick={toggleConnection}>Simulate Network Drop</button>\n      </div>\n    );\n  }\n\n  return (\n    <div style={{\n      backgroundColor: '#b91c1c',\n      color: 'white',\n      padding: '12px 16px',\n      fontFamily: 'sans-serif',\n      display: 'flex',\n      justifyContent: 'space-between',\n      alignItems: 'center'\n    }}>\n      <span>⚠️ No Internet Connection. Cached data is being shown.</span>\n      <button\n        onClick={toggleConnection}\n        style={{ background: 'white', color: '#b91c1c', border: 'none', padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}\n      >\n        Retry\n      </button>\n    </div>\n  );\n}\n`
        },
        followUpPrompts: [
          "How would you integrate this with automatic background request queuing when the device regains connection?",
          "How do you test this hook in a CI/CD environment with Jest and React Native Testing Library?"
        ]
      },
      {
        order: 4,
        text: "How do you handle mobile platform essentials like push notifications (FCM & APNs), deep linking / universal links, and sensitive device permissions (location, camera, biometric auth)?",
        description: "Discuss background payload handling, notification channels in Android, and Apple entitlements.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What is the difference between foreground, background, and quit-state notification handling?",
          "How do you handle runtime permission rejections gracefully so the user is guided to device settings?"
        ]
      },
      {
        order: 5,
        text: "Could you describe a challenging mobile bug or deployment issue you tackled—such as a subtle native memory leak, Android release crash, or App Store review guideline hurdle?",
        description: "Discuss debugging with Flipper/Xcode Instruments, store policies, or production crash analytics.",
        type: "OPEN_ENDED",
        starterCode: null,
        followUpPrompts: [
          "What tools (Sentry, Crashlytics, Datadog) do you rely on for real-time production error triage?",
          "How do you manage phased rollouts and instant hotfixes with tools like Expo Updates or CodePush?"
        ]
      }
    ]
  }
];

async function main() {
  console.log("Creating 5 interviews in Troven...");
  const results = [];

  for (const item of interviewsData) {
    const interviewId = uuidv4();
    const publicSlug = nanoid(10).toLowerCase();

    const { data: interview, error: intErr } = await supabase
      .from("interviews")
      .insert({
        id: interviewId,
        title: item.title,
        description: item.description,
        objective: item.objective,
        assessmentCriteria: item.assessmentCriteria,
        mode: "CHAT",
        allowModeSwitch: true,
        userId: userId,
        projectId: projectId,
        aiPersona: null,
        aiName: item.aiName,
        aiTone: "FRIENDLY",
        followUpDepth: "MODERATE",
        language: "en",
        isActive: true,
        timeLimitMinutes: 20,
        publicSlug: publicSlug,
        requireInvite: false,
        invitedEmails: [],
        videoMode: false,
        chatEnabled: true,
        voiceEnabled: true,
        videoEnabled: true,
        antiCheatingEnabled: true,
      })
      .select()
      .single();

    if (intErr) {
      console.error(`Failed to insert interview "${item.title}":`, intErr);
      continue;
    }

    const questionRows = item.questions.map(q => ({
      id: uuidv4(),
      interviewId: interviewId,
      order: q.order,
      text: q.text,
      description: q.description,
      type: q.type,
      options: null,
      starterCode: q.starterCode,
      validationRules: null,
      followUpPrompts: q.followUpPrompts,
      probeOnShort: true,
      probeThreshold: null,
      showIf: null,
      skipIf: null,
      timeLimitSeconds: q.type === "CODING" ? 180 : null,
      isRequired: true,
      allowFileUpload: false,
      allowedFileTypes: []
    }));

    const { error: qErr } = await supabase.from("questions").insert(questionRows);
    if (qErr) {
      console.error(`Failed to insert questions for "${item.title}":`, qErr);
    } else {
      console.log(`✓ Created: "${item.title}" (slug: ${publicSlug})`);
      results.push({
        title: item.title,
        slug: publicSlug,
        id: interviewId,
        questionsCount: questionRows.length,
        aiName: item.aiName,
        url: `https://interview.troven.in/i/${publicSlug}`
      });
    }
  }

  console.log("\nSUMMARY_OUTPUT_START");
  console.log(JSON.stringify(results, null, 2));
  console.log("SUMMARY_OUTPUT_END");
}

main();
