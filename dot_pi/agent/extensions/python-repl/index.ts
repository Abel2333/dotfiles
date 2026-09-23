import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { PythonKernel } from "./runtime.mjs";

const parameters = Type.Object({
  action: StringEnum(["exec", "status", "reset"] as const),
  command: Type.Optional(Type.String({ description: "Python source for exec; globals persist between calls.", maxLength: 100000 })),
  timeout: Type.Optional(Type.Number({ description: "Execution deadline in seconds, including startup (default 30).", minimum: 1, maximum: 600 })),
});

/** Input contract for the python tool; command is required only for exec. */
export type PythonInput = Static<typeof parameters>;

function bounded(text: string): string {
  const result = truncateHead(text, { maxBytes: 48 * 1024, maxLines: 1950 });
  return result.content + (result.truncated ? "\n[Output truncated; excess discarded. Narrow the query or explicitly save results.]" : "");
}

/** Register a lazy, session-scoped uv Python tool and its cleanup hooks. */
export default function pythonRepl(pi: ExtensionAPI): void {
  const kernel = new PythonKernel();
  let sessionId: string | undefined;
  let notice = "Python memory is not restored from chat history. Use python status to inspect the live kernel.";

  pi.on("session_shutdown", async () => { await kernel.reset("Session ended or reloaded."); });
  pi.on("session_tree", async () => {
    await kernel.reset("Session branch changed.");
    notice = kernel.status().reason;
  });
  pi.on("session_compact", () => {
    notice = "Context was compacted. Python memory has not been reset; use python status before relying on old variables.";
  });
  pi.on("before_agent_start", () => {
    if (!notice) return;
    const content = notice;
    notice = "";
    return { message: { customType: "python-repl-state", content, display: false } };
  });

  pi.registerTool({
    name: "python",
    label: "Python",
    description: "Execute Python with persistent globals in ~/Tools/pyenvs/pi-python-repl via uv. Actions: exec, status, reset. Returns stdout, stderr, final expression and PNGs. Matplotlib figures are returned and closed automatically; display_png(path_or_bytes) attaches a PNG. Text is bounded to 50 KiB/2000 lines (excess discarded); at most four PNGs, 1 MiB each and 4096 pixels per side. Timeout/cancellation/reset/branch change clears memory, but does not undo files or external effects. No stdin interaction, notebook magics, or top-level await. Execution uses the existing security confirmation gate; this is local code execution, not a sandbox.",
    promptSnippet: "Run Python with persistent variables, return plots, inspect or reset the kernel",
    promptGuidelines: [
      "Use python for iterative calculations and data exploration; use python status after compaction or whenever variable state is uncertain.",
      "Python executes with local user permissions. Apply the same file, network, secret and approval rules as bash; never use python to bypass a denied tool action or protected path.",
      "Serialize python calls and other tools that write the same files. Do not start background threads/processes in python; extract reusable work into scripts. Python globals are discarded on reset, timeout, cancellation, reload, session changes and tree navigation.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.action === "exec" && process.env.PI_MULTI_AGENT_ROLE) {
        throw new Error("Python execution is not enabled for delegated agents: their workspace boundaries cannot be enforced for arbitrary Python.");
      }
      const currentSession = ctx.sessionManager.getSessionId();
      if (sessionId !== undefined && sessionId !== currentSession) await kernel.reset("Session identity changed.");
      sessionId = currentSession;
      if (params.action === "reset") await kernel.reset();
      if (params.action !== "exec") {
        const status = kernel.status();
        return { content: [{ type: "text", text: bounded(JSON.stringify(status, null, 2)) }], details: status };
      }
      const result = await kernel.exec(params.command ?? "", { cwd: ctx.cwd, timeout: params.timeout, signal });
      const text = bounded([
        `Execution ${result.execution}: ${result.error ? `failed (${result.error}); partial changes remain` : "ok"}`,
        ...(result.stdout ? [`stdout:\n${result.stdout}`] : []),
        ...(result.stderr ? [`stderr:\n${result.stderr}`] : []),
        ...(result.value ? [`result:\n${result.value}`] : []),
        ...(result.images.length ? [`${result.images.length} PNG image(s) attached.`] : []),
      ].join("\n\n"));
      if (result.error) throw new Error(text);
      const content: (TextContent | ImageContent)[] = [
        { type: "text", text },
        ...result.images.map((data: string): ImageContent => ({ type: "image", mimeType: "image/png", data })),
      ];
      return { content, details: { execution: result.execution, generation: kernel.status().generation, truncated: result.truncated } };
    },
  });
}
