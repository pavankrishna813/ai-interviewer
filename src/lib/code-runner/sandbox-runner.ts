/**
 * In-browser sandbox code runner.
 * Executes JavaScript/TypeScript code in an isolated Web Worker
 * with console capture, return value extraction, and infinite-loop timeout protection.
 */

export interface ExecutionResult {
  success: boolean;
  logs: string[];
  result?: string;
  error?: string;
  executionTimeMs: number;
}

const WORKER_SCRIPT = `
self.onmessage = function(e) {
  var code = e.data.code;
  var logs = [];

  function stringifyArg(arg) {
    if (arg === undefined) return "undefined";
    if (arg === null) return "null";
    if (typeof arg === "function") return arg.toString();
    if (typeof arg === "object") {
      try {
        return JSON.stringify(arg, null, 2);
      } catch (err) {
        return String(arg);
      }
    }
    return String(arg);
  }

  function capture() {
    var args = Array.prototype.slice.call(arguments);
    logs.push(args.map(stringifyArg).join(" "));
  }

  var sandboxConsole = {
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    dir: capture,
  };

  try {
    var startTime = performance.now();
    var preprocessed = code
      .replace(/^\s*import\s+.*?from\s+['"].*?['"];?\s*$/gm, "// [import stripped]")
      .replace(/^\s*import\s+['"].*?['"];?\s*$/gm, "// [import stripped]")
      .replace(/^\s*export\s+default\s+/gm, "return ")
      .replace(/^\s*export\s+(const|let|var|function|class)\s+/gm, "$1 ")
      .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, "");

    function parseAttrs(attrStr) {
      if (!attrStr || !attrStr.trim()) return "null";
      var parts = [];
      var re = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;
      var m;
      while ((m = re.exec(attrStr)) !== null) {
        var key = m[1];
        var val = m[2] !== undefined ? JSON.stringify(m[2]) :
                  m[3] !== undefined ? JSON.stringify(m[3]) :
                  m[4] !== undefined ? m[4] : "true";
        parts.push(JSON.stringify(key) + ": " + val);
      }
      return "{" + parts.join(", ") + "}";
    }

    var jsxPasses = 0;
    while (jsxPasses < 8) {
      jsxPasses++;
      var prev = preprocessed;
      preprocessed = preprocessed.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z0-9_-]+(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}))?)*)\s*\/>/g, function(_, tag, attrs) {
        return "React.createElement('" + tag + "', " + parseAttrs(attrs) + ")";
      });
      preprocessed = preprocessed.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z0-9_-]+(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}))?)*)>([^<>]*)<\/\\1>/g, function(_, tag, attrs, children) {
        var trimmed = (children || "").trim();
        var childArg;
        if (!trimmed) {
          childArg = "";
        } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          childArg = ", " + trimmed.slice(1, -1);
        } else {
          childArg = ", " + JSON.stringify(trimmed);
        }
        return "React.createElement('" + tag + "', " + parseAttrs(attrs) + childArg + ")";
      });
      if (prev === preprocessed) break;
    }

    var preamble = [
      "var React = {",
      "  createElement: function(tag, props) {",
      "    var children = Array.prototype.slice.call(arguments, 2);",
      "    return { type: tag, props: props || {}, children: children };",
      "  },",
      "  useState: function(init) { return [init, function(){}]; },",
      "  useEffect: function() {},",
      "  useContext: function() {},",
      "  useMemo: function(fn) { return fn(); },",
      "  useCallback: function(fn) { return fn; },",
      "  useRef: function(init) { return { current: init }; }",
      "};",
      "var useState = React.useState;",
      "var useEffect = React.useEffect;",
      "var useContext = React.useContext;",
      "var useMemo = React.useMemo;",
      "var useCallback = React.useCallback;",
      "var useRef = React.useRef;"
    ].join("\\n");

    var executableCode = preamble + "\\n" + preprocessed;
    var runner = new Function("console", executableCode);
    var returnVal = runner(sandboxConsole);
    var executionTime = Math.round(performance.now() - startTime);

    var formattedResult;
    if (returnVal !== undefined) {
      formattedResult = typeof returnVal === "function"
        ? (returnVal.name ? "Component " + returnVal.name + " defined successfully" : "Component function defined successfully")
        : stringifyArg(returnVal);
    }

    self.postMessage({
      success: true,
      logs: logs,
      result: formattedResult,
      executionTimeMs: executionTime,
    });
  } catch (err) {
    self.postMessage({
      success: false,
      logs: logs,
      error: err && err.message ? err.message : String(err),
      executionTimeMs: 0,
    });
  }
};
`;

export function executeCodeInBrowser(
  code: string,
  timeoutMs = 3000
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    if (!code || !code.trim()) {
      resolve({
        success: true,
        logs: ["(No code to run)"],
        executionTimeMs: 0,
      });
      return;
    }

    let blobUrl: string | null = null;
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    function cleanup() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (worker) {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
        worker = null;
      }
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // ignore
        }
        blobUrl = null;
      }
    }

    try {
      const blob = new Blob([WORKER_SCRIPT], { type: "application/javascript" });
      blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          success: false,
          logs: [],
          error: `Execution timed out after ${timeoutMs}ms (infinite loop or hanging promise detected)`,
          executionTimeMs: timeoutMs,
        });
      }, timeoutMs);

      worker.onmessage = (event: MessageEvent<ExecutionResult>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(event.data);
      };

      worker.onerror = (errEvent) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          success: false,
          logs: [],
          error: errEvent.message || "Worker execution error",
          executionTimeMs: 0,
        });
      };

      worker.postMessage({ code });
    } catch (createErr) {
      cleanup();
      resolve({
        success: false,
        logs: [],
        error:
          createErr instanceof Error
            ? createErr.message
            : "Could not initialize execution worker",
        executionTimeMs: 0,
      });
    }
  });
}

export async function executeCodeRemote(
  code: string,
  language: string,
  stdin = ""
): Promise<ExecutionResult> {
  if (!code || !code.trim()) {
    return {
      success: true,
      logs: ["(No code to run)"],
      executionTimeMs: 0,
    };
  }

  try {
    const res = await fetch("/api/code/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, language, stdin }),
    });

    if (res.ok) {
      const data = await res.json();
      return data;
    }
    const errText = await res.text();
    return {
      success: false,
      logs: [],
      error: `Execution service error (${res.status}): ${errText}`,
      executionTimeMs: 0,
    };
  } catch (err) {
    // If network error and JS/TS, fallback to in-browser execution
    const l = (language || "").toLowerCase();
    if (l === "javascript" || l === "typescript" || l === "js" || l === "ts") {
      return executeCodeInBrowser(code, 4000);
    }
    return {
      success: false,
      logs: [],
      error: err instanceof Error ? err.message : "Failed to connect to execution service",
      executionTimeMs: 0,
    };
  }
}


