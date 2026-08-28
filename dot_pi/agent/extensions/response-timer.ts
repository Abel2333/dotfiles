/**
 * Response Timer Extension
 *
 * Footer status showing:
 * - live elapsed time while the agent works on a prompt
 * - final duration plus weighted decode TPS once the run settles
 * - TTFT only when the worst time-to-first-token exceeds a threshold
 *
 * Timing anchors:
 * - before_agent_start: new prompt run, reset all measurement state
 * - agent_start: fallback anchor for auto-retries (no before_agent_start)
 * - before_provider_request / message_update: per-call TTFT and decode window
 * - message_end: accumulate decode window and output tokens per assistant message
 * - agent_settled: run fully finished (no retry/compaction/follow-up left)
 * - session_start / session_shutdown: clear everything
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "response-timer";
const TICK_MS = 100;
// Decode windows shorter than this are too noisy for a meaningful TPS reading.
const MIN_DECODE_MS = 300;
// TTFT stays hidden unless the worst LLM call of the run exceeds this.
const TTFT_WARN_MS = 5000;

function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	if (m < 60) return `${m}m ${String(rem).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function formatTps(tokens: number, ms: number): string {
	const tps = tokens / (ms / 1000);
	return tps >= 10 ? `${Math.round(tps)}` : tps.toFixed(1);
}

export default function (pi: ExtensionAPI) {
	let startTime: number | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	// Per-run speed measurement, accumulated across all assistant messages.
	let requestStart: number | null = null;
	let firstTokenAt: number | null = null;
	let outputTokens = 0;
	let decodeMs = 0;
	let worstTtftMs = 0;

	function stopTicker() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function renderRunning(ctx: ExtensionContext) {
		if (startTime === null) return;
		const elapsed = formatDuration(Date.now() - startTime);
		const dot = ctx.ui.theme.fg("accent", "●");
		ctx.ui.setStatus(STATUS_KEY, dot + ctx.ui.theme.fg("dim", ` ${elapsed}`));
	}

	function startTicker(ctx: ExtensionContext) {
		stopTicker();
		renderRunning(ctx);
		timer = setInterval(() => renderRunning(ctx), TICK_MS);
		// Never keep the process alive just for this ticker.
		(timer as unknown as { unref?: () => void }).unref?.();
	}

	function start(ctx: ExtensionContext) {
		startTime = Date.now();
		requestStart = null;
		firstTokenAt = null;
		outputTokens = 0;
		decodeMs = 0;
		worstTtftMs = 0;
		startTicker(ctx);
	}

	function finish(ctx: ExtensionContext) {
		if (startTime === null) return;
		stopTicker();
		const elapsed = Date.now() - startTime;
		startTime = null;

		let text = ` ${formatDuration(elapsed)}`;
		if (outputTokens > 0 && decodeMs >= MIN_DECODE_MS) {
			text += ` · ${formatTps(outputTokens, decodeMs)} t/s`;
		}
		if (worstTtftMs >= TTFT_WARN_MS) {
			text += ` · TTFT ${formatDuration(worstTtftMs)}`;
		}

		const check = ctx.ui.theme.fg("success", "✓");
		ctx.ui.setStatus(STATUS_KEY, check + ctx.ui.theme.fg("dim", text));
	}

	function reset(ctx: ExtensionContext) {
		stopTicker();
		startTime = null;
		requestStart = null;
		firstTokenAt = null;
		outputTokens = 0;
		decodeMs = 0;
		worstTtftMs = 0;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		start(ctx);
	});

	// Auto-retry after an error fires agent_start without before_agent_start.
	pi.on("agent_start", async (_event, ctx) => {
		if (startTime === null) start(ctx);
	});

	pi.on("before_provider_request", async () => {
		requestStart = Date.now();
		firstTokenAt = null;
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		if (firstTokenAt !== null || requestStart === null) return;
		firstTokenAt = Date.now();
		const ttft = firstTokenAt - requestStart;
		if (ttft > worstTtftMs) worstTtftMs = ttft;
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const output = event.message.usage?.output ?? 0;
		if (firstTokenAt !== null && output > 0) {
			const windowMs = Date.now() - firstTokenAt;
			if (windowMs >= MIN_DECODE_MS) {
				outputTokens += output;
				decodeMs += windowMs;
			}
		}
		firstTokenAt = null;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		finish(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		reset(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTicker();
		startTime = null;
	});
}
