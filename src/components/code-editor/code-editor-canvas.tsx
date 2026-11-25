"use client";

import {
  useCallback,
  useState,
  useImperativeHandle,
  forwardRef,
  useEffect,
  useRef,
} from "react";
import {
  Play,
  Terminal,
  ChevronDown,
  ChevronUp,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  executeCodeInBrowser,
  executeCodeRemote,
  type ExecutionResult,
} from "@/lib/code-runner/sandbox-runner";

export interface CodeEditorCanvasRef {
  /** Returns true if the editor has any non-empty code. */
  hasContent: () => boolean;
  /** Returns the current code string (or null if empty). */
  getSnapshotData: () => string | null;
  /** Loads previously saved code + language into the editor. */
  loadScene: (data: string) => void;
  /** Clears the editor. */
  resetScene: () => void;
  /** Returns the current language. */
  getLanguage: () => string;
  /** Programmatically runs code in sandbox. */
  runCode: () => Promise<ExecutionResult>;
}

interface CodeEditorCanvasProps {
  /** If true, the editor is read-only. */
  readOnly?: boolean;
  /** JSON string of previously saved state to preload: { code, language } */
  initialData?: string;
  /** Called on every meaningful change (debounced). Use for auto-save. */
  onAutoSave?: (snapshotData: string) => void;
  /** Auto-save debounce interval in ms. Default 3000. */
  autoSaveInterval?: number;
  /** If true, fill the parent container instead of using a fixed height. */
  fillParent?: boolean;
  /** Called immediately on any change (before debounce). Use for dirty-state tracking. */
  onDirty?: () => void;
  /** If true, use dark theme for the editor. Default false. */
  dark?: boolean;
  /** Callback fired when code execution finishes */
  onRunCode?: (result: ExecutionResult, code: string, language: string) => void;
  /** Callback fired on keystroke (for typing activity tracking) */
  onUserTyped?: () => void;
}

const SUPPORTED_LANGUAGES = [
  { value: "javascript", label: "JavaScript / React (JSX)" },
  { value: "typescript", label: "TypeScript / React (TSX)" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "cpp", label: "C++" },
  { value: "c", label: "C" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "sql", label: "SQL" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "json", label: "JSON" },
  { value: "markdown", label: "Markdown" },
  { value: "shell", label: "Shell" },
] as const;

export { SUPPORTED_LANGUAGES };

export const CodeEditorCanvas = forwardRef<CodeEditorCanvasRef, CodeEditorCanvasProps>(
  function CodeEditorCanvas(
    {
      readOnly = false,
      initialData,
      onAutoSave,
      autoSaveInterval = 3000,
      fillParent = false,
      onDirty,
      dark = false,
      onRunCode,
      onUserTyped,
    },
    ref,
  ) {
    // Dynamically loaded Monaco Editor component
    const [Editor, setEditor] = useState<React.ComponentType<Record<string, unknown>> | null>(null);

    const codeRef = useRef("");
    const languageRef = useRef("javascript");
    const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onAutoSaveRef = useRef(onAutoSave);
    onAutoSaveRef.current = onAutoSave;
    const onDirtyRef = useRef(onDirty);
    onDirtyRef.current = onDirty;
    const onRunCodeRef = useRef(onRunCode);
    onRunCodeRef.current = onRunCode;
    const onUserTypedRef = useRef(onUserTyped);
    onUserTypedRef.current = onUserTyped;
    const editorInstanceRef = useRef<any>(null);
    const lastSnapshot = useRef("");

    // Execution state
    const [isRunning, setIsRunning] = useState(false);
    const [outputResult, setOutputResult] = useState<ExecutionResult | null>(null);
    const [isOutputOpen, setIsOutputOpen] = useState(false);

    // ── Parse initial data ────────────────────────────────────────
    const parsedInitial = useRef<{ code: string; language: string } | null>(null);
    if (initialData && !parsedInitial.current) {
      try {
        const raw = JSON.parse(initialData);
        parsedInitial.current = {
          code: raw.code ?? "",
          language: raw.language ?? "javascript",
        };
        codeRef.current = parsedInitial.current.code;
        languageRef.current = parsedInitial.current.language;
      } catch {
        // ignore bad data
      }
    }

    const [language, setLanguage] = useState(parsedInitial.current?.language ?? "javascript");

    // ── Dynamic import (Monaco cannot be SSR'd) ───────────────────
    useEffect(() => {
      let cancelled = false;
      import("@monaco-editor/react").then((mod) => {
        if (cancelled) return;
        setEditor(() => mod.default as unknown as React.ComponentType<Record<string, unknown>>);
      });
      return () => { cancelled = true; };
    }, []);

    // ── Code Execution Handler ────────────────────────────────────
    const handleRunCode = useCallback(async (): Promise<ExecutionResult> => {
      if (isRunning) {
        return (
          outputResult || {
            success: false,
            logs: ["Execution already in progress..."],
            executionTimeMs: 0,
          }
        );
      }
      setIsRunning(true);
      setIsOutputOpen(true);

      const code = codeRef.current;
      const currentLang = languageRef.current;

      try {
        const result = await executeCodeRemote(code, currentLang);
        setOutputResult(result);
        onRunCodeRef.current?.(result, code, currentLang);
        return result;
      } catch (err) {
        const errResult: ExecutionResult = {
          success: false,
          logs: [],
          error: err instanceof Error ? err.message : String(err),
          executionTimeMs: 0,
        };
        setOutputResult(errResult);
        onRunCodeRef.current?.(errResult, code, currentLang);
        return errResult;
      } finally {
        setIsRunning(false);
      }
    }, [isRunning]);

    const runActionRef = useRef(handleRunCode);
    runActionRef.current = handleRunCode;

    // ── Monaco Before Mount (Configure ES2020 & IntelliSense) ────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleBeforeMount = useCallback((monaco: any) => {
      try {
        const reactDts = `
          declare namespace React {
            interface ReactElement<P = any, T extends string | any = string | any> {
              type: T;
              props: P;
              key: string | null;
            }
            type FC<P = {}> = (props: P) => ReactElement | null;
            function createElement(type: any, props?: any, ...children: any[]): ReactElement;
            function useState<T>(initialState: T | (() => T)): [T, (newState: T | ((prev: T) => T)) => void];
            function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
            function useContext<T>(context: any): T;
            function useReducer<R extends (state: any, action: any) => any>(reducer: R, initialState: any): [any, (action: any) => void];
            function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly any[]): T;
            function useMemo<T>(factory: () => T, deps: readonly any[] | undefined): T;
            function useRef<T>(initialValue: T): { current: T };
          }
          declare const React: typeof React;
          declare const useState: typeof React.useState;
          declare const useEffect: typeof React.useEffect;
          declare const useContext: typeof React.useContext;
          declare const useMemo: typeof React.useMemo;
          declare const useCallback: typeof React.useCallback;
          declare const useRef: typeof React.useRef;
        `;

        if (monaco?.languages?.typescript?.javascriptDefaults) {
          monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
          });
          monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ES2020,
            allowNonTextExtensions: true,
            checkJs: false,
            allowJs: true,
            jsx: monaco.languages.typescript.JsxEmit.React,
            jsxFactory: "React.createElement",
            allowSyntheticDefaultImports: true,
            esModuleInterop: true,
          });
          monaco.languages.typescript.javascriptDefaults.addExtraLib(reactDts, "ts:react.d.ts");
        }
        if (monaco?.languages?.typescript?.typescriptDefaults) {
          monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ES2020,
            allowNonTextExtensions: true,
            jsx: monaco.languages.typescript.JsxEmit.React,
            jsxFactory: "React.createElement",
            allowSyntheticDefaultImports: true,
            esModuleInterop: true,
          });
          monaco.languages.typescript.typescriptDefaults.addExtraLib(reactDts, "ts:react.d.ts");
        }
      } catch (err) {
        console.warn("[Monaco] Could not set compiler options:", err);
      }
    }, []);

    // ── Monaco On Mount (Keyboard Shortcuts: Ctrl/Cmd + Enter) ───
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleOnMount = useCallback((editor: any, monaco: any) => {
      editorInstanceRef.current = editor;
      try {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
          void runActionRef.current();
        });
      } catch (err) {
        console.warn("[Monaco] Could not bind run shortcut:", err);
      }
    }, []);

    // ── Handle code changes ───────────────────────────────────────
    const handleChange = useCallback((value: string | undefined) => {
      const code = value ?? "";
      codeRef.current = code;

      const snapshot = JSON.stringify({ code, language: languageRef.current });
      if (snapshot === lastSnapshot.current) return;
      lastSnapshot.current = snapshot;

      onDirtyRef.current?.();
      onUserTypedRef.current?.();

      if (!onAutoSaveRef.current) return;
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => {
        if (!onAutoSaveRef.current) return;
        if (!codeRef.current.trim()) return;
        onAutoSaveRef.current(JSON.stringify({ code: codeRef.current, language: languageRef.current }));
      }, autoSaveInterval);
    }, [autoSaveInterval]);

    // ── Handle language changes ───────────────────────────────────
    const handleLanguageChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
      const newLang = e.target.value;
      setLanguage(newLang);
      languageRef.current = newLang;

      const snapshot = JSON.stringify({ code: codeRef.current, language: newLang });
      if (snapshot === lastSnapshot.current) return;
      lastSnapshot.current = snapshot;

      onDirtyRef.current?.();

      if (!onAutoSaveRef.current) return;
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => {
        if (!onAutoSaveRef.current || !codeRef.current.trim()) return;
        onAutoSaveRef.current(JSON.stringify({ code: codeRef.current, language: languageRef.current }));
      }, autoSaveInterval);
    }, [autoSaveInterval]);

    // Cleanup timer on unmount
    useEffect(() => {
      return () => {
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      };
    }, []);

    // ── Imperative ref for parent components ──────────────────────
    useImperativeHandle(
      ref,
      () => ({
        hasContent() {
          return codeRef.current.trim().length > 0;
        },

        getSnapshotData() {
          if (!codeRef.current.trim()) return null;
          return JSON.stringify({ code: codeRef.current, language: languageRef.current });
        },

        loadScene(data: string) {
          try {
            const parsed = JSON.parse(data);
            codeRef.current = parsed.code ?? "";
            languageRef.current = parsed.language ?? "javascript";
            setLanguage(parsed.language ?? "javascript");
            setEditorKey((k) => k + 1);
          } catch {
            // ignore bad data
          }
        },

        resetScene() {
          codeRef.current = "";
          languageRef.current = "javascript";
          setLanguage("javascript");
          setOutputResult(null);
          setEditorKey((k) => k + 1);
        },

        getLanguage() {
          return languageRef.current;
        },

        runCode() {
          return handleRunCode();
        },
      }),
      [handleRunCode],
    );

    // Key to force re-mount Monaco when loading new content
    const [editorKey, setEditorKey] = useState(0);

    // ── Render ────────────────────────────────────────────────────
    if (!Editor) {
      return (
        <div
          className={`flex items-center justify-center text-muted-foreground ${
            fillParent ? "h-full w-full" : "h-[400px] w-full rounded-lg border"
          }`}
        >
          Loading code editor...
        </div>
      );
    }

    return (
      <div
        className={
          fillParent
            ? "flex h-full w-full flex-col overflow-hidden bg-background"
            : "flex h-[400px] w-full flex-col rounded-lg border overflow-hidden bg-background"
        }
      >
        {/* Editor Toolbar */}
        <div
          className={
            dark
              ? "flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5"
              : "flex items-center justify-between border-b bg-card px-3 py-1.5"
          }
        >
          {/* Left: Language selector */}
          <div className="flex items-center gap-2">
            <select
              value={language}
              onChange={handleLanguageChange}
              disabled={readOnly}
              className={
                dark
                  ? "rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 outline-none transition-colors focus:ring-1 focus:ring-zinc-500 hover:bg-zinc-700"
                  : "rounded-md border bg-background px-2.5 py-1 text-xs font-medium shadow-sm outline-none transition-colors focus:ring-1 focus:ring-ring hover:bg-muted/50"
              }
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>

          {/* Right: Run Button & Console Toggle */}
          <div className="flex items-center gap-2">
            {/* Console drawer toggle */}
            <button
              type="button"
              onClick={() => setIsOutputOpen((prev) => !prev)}
              className={
                dark
                  ? "flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700"
                  : "flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted/60"
              }
              title="Toggle Console Output Drawer"
            >
              <Terminal className="h-3.5 w-3.5 text-zinc-400" />
              <span>Console</span>
              {outputResult && (
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    outputResult.success ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                />
              )}
            </button>

            {/* Run Code Button */}
            <button
              type="button"
              onClick={handleRunCode}
              disabled={readOnly || isRunning}
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white shadow-sm transition-all hover:bg-emerald-500 active:scale-95 disabled:opacity-50"
              title="Execute code in browser (Ctrl + Enter)"
            >
              {isRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
              <span>{isRunning ? "Running..." : "Run"}</span>
              <kbd className="hidden sm:inline-block rounded bg-emerald-800/60 px-1 py-0.2 text-[10px] text-emerald-200">
                Ctrl+↵
              </kbd>
            </button>
          </div>
        </div>

        {/* Monaco Editor Canvas */}
        <div className="flex-1 min-h-0 relative">
          <Editor
            key={editorKey}
            defaultLanguage={language}
            language={language}
            defaultValue={codeRef.current}
            onChange={handleChange}
            beforeMount={handleBeforeMount}
            onMount={handleOnMount}
            theme={dark ? "vs-dark" : "vs-light"}
            options={{
              readOnly,
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: "on" as const,
              scrollBeyondLastLine: false,
              wordWrap: "on" as const,
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 8 },
              quickSuggestions: {
                other: true,
                comments: false,
                strings: true,
              },
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnEnter: "on" as const,
              tabCompletion: "on" as const,
              wordBasedSuggestions: "currentDocument" as const,
              parameterHints: {
                enabled: true,
              },
              formatOnPaste: true,
              formatOnType: true,
              snippetSuggestions: "inline" as const,
              autoClosingBrackets: "always" as const,
              autoClosingQuotes: "always" as const,
              autoSurround: "languageDefined" as const,
              scrollbar: {
                vertical: "auto" as const,
                horizontal: "auto" as const,
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
                useShadows: false,
              },
              overviewRulerLanes: 0,
            }}
          />
        </div>

        {/* Console Output Drawer */}
        {isOutputOpen && (
          <div className="border-t border-zinc-800 bg-zinc-950 text-zinc-100 flex flex-col h-40 max-h-52 transition-all">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-1.5 bg-zinc-900/90 text-xs">
              <div className="flex items-center gap-2">
                <Terminal className="h-3.5 w-3.5 text-zinc-400" />
                <span className="font-semibold text-zinc-200">Console Output</span>
                {outputResult && (
                  <div className="flex items-center gap-1.5 ml-2">
                    {outputResult.success ? (
                      <span className="flex items-center gap-1 rounded bg-emerald-950/80 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-800/50">
                        <CheckCircle2 className="h-3 w-3" />
                        Success ({outputResult.executionTimeMs}ms)
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 rounded bg-rose-950/80 px-1.5 py-0.5 text-[10px] font-medium text-rose-400 border border-rose-800/50">
                        <AlertCircle className="h-3 w-3" />
                        Error ({outputResult.executionTimeMs}ms)
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1">
                {outputResult && (
                  <button
                    type="button"
                    onClick={() => setOutputResult(null)}
                    className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                    title="Clear Output"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsOutputOpen(false)}
                  className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  title="Collapse Console"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-1.5 select-text">
              {!outputResult ? (
                <div className="text-zinc-500 italic">
                  Press &quot;Run&quot; or Ctrl+Enter to execute JavaScript in browser.
                </div>
              ) : (
                <>
                  {outputResult.logs.length > 0 && (
                    <div className="space-y-1">
                      {outputResult.logs.map((logLine, idx) => (
                        <div key={idx} className="text-zinc-300 leading-relaxed whitespace-pre-wrap">
                          <span className="text-zinc-500 mr-2">&gt;</span>
                          {logLine}
                        </div>
                      ))}
                    </div>
                  )}

                  {outputResult.result !== undefined && (
                    <div className="pt-1 text-emerald-400 leading-relaxed whitespace-pre-wrap">
                      <span className="text-zinc-500 mr-2">&lt;</span>
                      <span className="text-emerald-500 font-semibold">[Return]</span> {outputResult.result}
                    </div>
                  )}

                  {outputResult.error && (
                    <div className="pt-1 text-rose-400 leading-relaxed whitespace-pre-wrap">
                      <span className="text-rose-500 font-semibold">✖ Runtime Error:</span> {outputResult.error}
                    </div>
                  )}

                  {outputResult.logs.length === 0 && outputResult.result === undefined && !outputResult.error && (
                    <div className="text-zinc-400 italic">
                      Code executed successfully with no logs or return value.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);
