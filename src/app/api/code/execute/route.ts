import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import * as esbuild from "esbuild";
import vm from "vm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __non_webpack_require__: any;

function getRuntimeReact() {
  try {
    const nodeReq =
      typeof __non_webpack_require__ !== "undefined"
        ? __non_webpack_require__
        : eval("require");
    const react = nodeReq("react");
    const serverMod = nodeReq("react-dom/server");
    const renderFn =
      serverMod.renderToStaticMarkup || serverMod.default?.renderToStaticMarkup;
    return { react, renderFn, nodeReq };
  } catch (err) {
    console.error("[Code Runner] Failed to resolve React runtime:", err);
    return { react: null, renderFn: null, nodeReq: null };
  }
}

const PISTON_URL = process.env.PISTON_URL || "http://127.0.0.1:2000";
const EXECUTION_TIMEOUT_MS = 6000;

interface ExecutionResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  logs: string[];
  result?: string;
  error?: string;
  executionTimeMs: number;
}

function stringifyArg(arg: unknown): string {
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  if (typeof arg === "function") return arg.name ? `[Function: ${arg.name}]` : "[Function]";
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

async function executeJsTsReact(code: string, isTs: boolean): Promise<ExecutionResponse> {
  const startTime = Date.now();
  const { react: ReactInstance, renderFn: renderToStaticMarkupFn, nodeReq } = getRuntimeReact();

  let compiled: string;
  try {
    const res = await esbuild.transform(code, {
      loader: isTs ? "tsx" : "jsx",
      format: "cjs",
      target: "node20",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
    });
    compiled = res.code;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      stdout: "",
      stderr: errMsg,
      logs: [errMsg],
      error: errMsg,
      executionTimeMs: Date.now() - startTime,
    };
  }

  const logs: string[] = [];
  const sandbox: Record<string, unknown> = {
    require: (mod: string) => {
      if (mod === "react") return ReactInstance;
      if (mod === "react-dom/server") return { renderToStaticMarkup: renderToStaticMarkupFn };
      try {
        return nodeReq ? nodeReq(mod) : {};
      } catch {
        return {};
      }
    },
    console: {
      log: (...args: unknown[]) => logs.push(args.map(stringifyArg).join(" ")),
      error: (...args: unknown[]) => logs.push("[error] " + args.map(stringifyArg).join(" ")),
      warn: (...args: unknown[]) => logs.push("[warn] " + args.map(stringifyArg).join(" ")),
      info: (...args: unknown[]) => logs.push(args.map(stringifyArg).join(" ")),
    },
    React: ReactInstance,
    module: { exports: {} },
    exports: {},
    process: { env: { NODE_ENV: "development" } },
    setTimeout: () => {},
    clearTimeout: () => {},
  };

  try {
    vm.createContext(sandbox);
    const returnVal = vm.runInContext(compiled, sandbox, { timeout: 4000 });
    const duration = Date.now() - startTime;

    // Detect if a React component was exported or declared
    const modExports = (sandbox.module as { exports: Record<string, unknown> })?.exports || {};
    let candidateComp: unknown =
      modExports.default ||
      modExports.App ||
      modExports.Greeting ||
      modExports.Component ||
      (typeof returnVal === "function" ? returnVal : null);

    if (!candidateComp) {
      for (const key of Object.keys(sandbox)) {
        if (/^[A-Z]/.test(key) && typeof sandbox[key] === "function" && key !== "React") {
          candidateComp = sandbox[key];
          break;
        }
      }
    }

    let renderedHtml = "";
    if (typeof candidateComp === "function" && ReactInstance && renderToStaticMarkupFn) {
      try {
        // Try rendering with friendly sample props { name: "Candidate" } if component destructures props
        try {
          const elementWithProps = ReactInstance.createElement(candidateComp, { name: "Candidate" });
          if (ReactInstance.isValidElement(elementWithProps)) {
            renderedHtml = renderToStaticMarkupFn(elementWithProps);
          }
        } catch {
          const element = ReactInstance.createElement(candidateComp, {});
          if (ReactInstance.isValidElement(element)) {
            renderedHtml = renderToStaticMarkupFn(element);
          }
        }
      } catch (renderErr) {
        const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
        logs.push(`[React Render Warning]: ${msg}`);
      }
    }

    if (renderedHtml) {
      logs.push(`[React Component Render Output]:\n${renderedHtml}`);
    }

    const compName =
      typeof candidateComp === "function" && candidateComp.name
        ? candidateComp.name
        : "Component";

    return {
      success: true,
      stdout: logs.join("\n"),
      stderr: "",
      logs,
      result: renderedHtml
        ? `Rendered <${compName} />`
        : returnVal !== undefined
        ? stringifyArg(returnVal)
        : logs.length > 0
        ? undefined
        : "Code executed successfully with no logs or return value",
      executionTimeMs: duration,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      stdout: logs.join("\n"),
      stderr: errMsg,
      logs: [...logs, `[Runtime Error] ${errMsg}`],
      error: errMsg,
      executionTimeMs: Date.now() - startTime,
    };
  }
}

function normalizeLanguage(lang: string): string {
  const l = (lang || "").toLowerCase().trim();
  if (["python", "python3", "py", "py3"].includes(l)) return "python";
  if (["javascript", "js", "node", "jsx", "react"].includes(l)) return "javascript";
  if (["typescript", "ts", "tsx"].includes(l)) return "typescript";
  if (["cpp", "c++", "cxx", "cc"].includes(l)) return "cpp";
  if (["c"].includes(l)) return "c";
  if (["java"].includes(l)) return "java";
  if (["go", "golang"].includes(l)) return "go";
  if (["rust", "rs"].includes(l)) return "rust";
  if (["sql", "sqlite", "sqlite3"].includes(l)) return "sql";
  if (["shell", "bash", "sh"].includes(l)) return "bash";
  return l;
}

async function tryPistonExecution(
  language: string,
  code: string,
  stdin = ""
): Promise<ExecutionResponse | null> {
  try {
    let pistonLang = language;
    if (language === "cpp") pistonLang = "c++";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);

    const res = await fetch(`${PISTON_URL}/api/v2/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: pistonLang,
        version: "*",
        files: [{ content: code }],
        stdin,
        run_timeout: 4000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.run) return null;

    const run = data.run;
    const compile = data.compile;

    const stdout = (run.stdout || "").trimEnd();
    const stderr = [compile?.stderr, run.stderr].filter(Boolean).join("\n").trimEnd();
    const isSuccess = run.code === 0 && (!compile || compile.code === 0);

    const logs: string[] = [];
    if (compile?.stdout) logs.push(compile.stdout);
    if (compile?.stderr) logs.push(`[Compiler Error]\n${compile.stderr}`);
    if (stdout) logs.push(stdout);
    if (stderr && isSuccess) logs.push(`[stderr]\n${stderr}`);

    return {
      success: isSuccess,
      stdout,
      stderr,
      logs,
      result: isSuccess ? (stdout ? undefined : "Program executed successfully with no output") : undefined,
      error: !isSuccess ? (stderr || `Process exited with code ${run.code}`) : undefined,
      executionTimeMs: Math.round((run.wall_time || run.cpu_time || 0) * 1000),
    };
  } catch {
    return null;
  }
}

async function executeLocally(
  language: string,
  code: string,
  stdin = ""
): Promise<ExecutionResponse> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-exec-"));
  const startTime = Date.now();

  try {
    let filename = "solution.txt";
    let compileCmd: string[] | null = null;
    let runCmd: string[] = [];

    switch (language) {
      case "python":
        filename = "main.py";
        runCmd = ["python3", "-u", path.join(tmpDir, filename)];
        break;

      case "javascript":
        filename = "main.js";
        runCmd = ["node", path.join(tmpDir, filename)];
        break;

      case "typescript":
        filename = "main.ts";
        // Node 20/22+ can run or we transpile; strip simple types or run via node
        runCmd = ["node", "--no-warnings", path.join(tmpDir, filename)];
        break;

      case "c": {
        filename = "main.c";
        const outBin = path.join(tmpDir, "a.out");
        compileCmd = ["gcc", "-O2", "-pipe", path.join(tmpDir, filename), "-o", outBin, "-lm"];
        runCmd = [outBin];
        break;
      }

      case "cpp": {
        filename = "main.cpp";
        const outBin = path.join(tmpDir, "a.out");
        compileCmd = ["g++", "-O2", "-std=c++20", path.join(tmpDir, filename), "-o", outBin];
        runCmd = [outBin];
        break;
      }

      case "java": {
        // Find public class name or default to Main
        const classMatch = code.match(/public\s+class\s+([A-Za-z0-9_]+)/);
        const className = classMatch ? classMatch[1] : "Main";
        filename = `${className}.java`;
        compileCmd = ["javac", path.join(tmpDir, filename)];
        runCmd = ["java", "-cp", tmpDir, className];
        break;
      }

      case "go": {
        filename = "main.go";
        runCmd = ["go", "run", path.join(tmpDir, filename)];
        break;
      }

      case "rust": {
        filename = "main.rs";
        const outBin = path.join(tmpDir, "a.out");
        compileCmd = ["rustc", "-O", path.join(tmpDir, filename), "-o", outBin];
        runCmd = [outBin];
        break;
      }

      case "sql": {
        filename = "query.sql";
        runCmd = ["sqlite3", ":memory:", "-header", "-column"];
        break;
      }

      case "bash": {
        filename = "script.sh";
        runCmd = ["bash", path.join(tmpDir, filename)];
        break;
      }

      default:
        return {
          success: false,
          stdout: "",
          stderr: `Unsupported language: ${language}`,
          logs: [`Unsupported language: ${language}`],
          error: `Language ${language} is not supported on this execution environment`,
          executionTimeMs: 0,
        };
    }

    await fs.writeFile(path.join(tmpDir, filename), code, "utf8");

    // 1. Compilation step (if required)
    if (compileCmd) {
      const compileResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(compileCmd![0], compileCmd!.slice(1), { timeout: 8000, cwd: tmpDir }, (err, stdout, stderr) => {
          resolve({
            code: err ? (err.code ? Number(err.code) : 1) : 0,
            stdout: stdout || "",
            stderr: stderr || (err ? err.message : ""),
          });
        });
      });

      if (compileResult.code !== 0) {
        const duration = Date.now() - startTime;
        return {
          success: false,
          stdout: compileResult.stdout,
          stderr: compileResult.stderr,
          logs: [`[Compilation Error]\n${compileResult.stderr}`],
          error: compileResult.stderr || "Compilation failed",
          executionTimeMs: duration,
        };
      }
    }

    // 2. Execution step
    const execResult = await new Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>((resolve) => {
      const child = execFile(
        runCmd[0],
        runCmd.slice(1),
        {
          cwd: tmpDir,
          timeout: EXECUTION_TIMEOUT_MS,
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, HOME: tmpDir, GOCACHE: "/tmp/gocache" },
        },
        (err, stdout, stderr) => {
          const isTimeout = err?.killed || err?.signal === "SIGTERM" || (err as { code?: string })?.code === "ETIMEDOUT";
          resolve({
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
            stdout: stdout || "",
            stderr: stderr || (err && !isTimeout ? err.message : ""),
            timedOut: isTimeout,
          });
        }
      );

      if (child.stdin) {
        if (language === "sql") {
          child.stdin.write(code);
        } else if (stdin) {
          child.stdin.write(stdin);
        }
        child.stdin.end();
      }
    });

    const duration = Date.now() - startTime;
    const isSuccess = execResult.code === 0 && !execResult.timedOut;
    const stdout = execResult.stdout.trimEnd();
    const stderr = execResult.stderr.trimEnd();

    const logs: string[] = [];
    if (execResult.timedOut) {
      logs.push(`Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000} seconds.`);
    } else {
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(`[stderr]\n${stderr}`);
    }

    return {
      success: isSuccess,
      stdout,
      stderr,
      logs,
      result: isSuccess ? (stdout ? undefined : "Program exited successfully (0)") : undefined,
      error: execResult.timedOut
        ? `Time Limit Exceeded (${EXECUTION_TIMEOUT_MS / 1000}s)`
        : (!isSuccess ? (stderr || `Process exited with code ${execResult.code}`) : undefined),
      executionTimeMs: duration,
    };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { code, language, stdin = "" } = body || {};

    if (!code || typeof code !== "string" || !code.trim()) {
      return NextResponse.json<ExecutionResponse>({
        success: true,
        stdout: "",
        stderr: "",
        logs: ["(No code to run)"],
        executionTimeMs: 0,
      });
    }

    const normLang = normalizeLanguage(language);

    // 1. JavaScript, TypeScript, and React (JSX / TSX)
    if (normLang === "javascript" || normLang === "typescript") {
      const jsResult = await executeJsTsReact(code, normLang === "typescript");
      return NextResponse.json(jsResult);
    }

    // 2. Try Piston open-source container execution first (Python, C++, Java, Go, Rust, etc.)
    const pistonResult = await tryPistonExecution(normLang, code, stdin);
    if (pistonResult) {
      return NextResponse.json(pistonResult);
    }

    // 3. Fall back to local host compilers (GCC, G++, Python, OpenJDK, etc.)
    const localResult = await executeLocally(normLang, code, stdin);
    return NextResponse.json(localResult);
  } catch (err) {
    return NextResponse.json<ExecutionResponse>(
      {
        success: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        logs: [],
        error: err instanceof Error ? err.message : "Execution failure",
        executionTimeMs: 0,
      },
      { status: 500 }
    );
  }
}
