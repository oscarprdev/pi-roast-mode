import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RoastModeState } from "./state.js";

const STATUS_KEY = "roast-mode";
const ROAST_WIDGET_KEY = "roast-mode-roast";

export function updateRoastModeUi(
	ctx: ExtensionContext,
	state: RoastModeState,
	toolSummary: () => string,
) {
	ctx.ui.setStatus(STATUS_KEY, formatStatus(state));
	if (state.enabled && state.latestRoast) {
		ctx.ui.setWidget(ROAST_WIDGET_KEY, [
			"Proposed roast ready",
			"Use /roast to implement, save, revise, or exit Roast mode.",
		]);
	} else if (state.enabled) {
		ctx.ui.setWidget(ROAST_WIDGET_KEY, [
			"Roast mode: roasting",
			toolSummary(),
			"Finish with roast_mode_complete when decision-ready.",
		]);
	} else if (state.savedRoast) {
		ctx.ui.setWidget(ROAST_WIDGET_KEY, [
			"Roast saved for later",
			"Use /roast to show, implement, or clear it.",
		]);
	} else if (state.activeImplementation) {
		ctx.ui.setWidget(ROAST_WIDGET_KEY, [
			"Implementation roast active",
			"Use /roast to show, replace, or clear it.",
		]);
	} else {
		ctx.ui.setWidget(ROAST_WIDGET_KEY, undefined);
	}
}

export function clearRoastModeUi(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(ROAST_WIDGET_KEY, undefined);
}

export function showStoredRoast(pi: ExtensionAPI, ctx: ExtensionContext, state: RoastModeState) {
	const readyRoast = state.enabled ? state.latestRoast?.trim() : undefined;
	const savedRoast = state.savedRoast?.roast.trim();
	if (savedRoast && (ctx.mode === "print" || ctx.mode === "json")) {
		throw new Error("Saved roast display is unavailable in print/JSON mode. Use TUI or RPC.");
	}
	const activeRoast = state.activeImplementation?.roast.trim();
	const roast = readyRoast ?? savedRoast ?? activeRoast;
	if (!roast) {
		ctx.ui.notify(
			"No completed roast is available. Use /roast finalize when roasting is complete.",
			"info",
		);
		return;
	}
	const title = readyRoast
		? "Proposed Roast"
		: savedRoast
			? "Saved Roast"
			: "Active Implementation Roast";
	showRoastModeRoast(pi, ctx, title, roast);
}

export function showRoastModeRoast(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	roast: string,
) {
	try {
		pi.sendMessage(
			{
				customType: "proposed-roast",
				content: `**${title}**\n\n${roast}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Unable to show completed roast: ${detail}`, "error");
	}
}

export function roastModeStatusText(state: RoastModeState, toolSummary: () => string) {
	if (state.enabled) {
		if (state.latestRoast) {
			return `Roast mode is active and a proposed roast is ready. ${toolSummary()}`;
		}
		return `Roast mode is active. ${toolSummary()} Explore, ask, and finish with roast_mode_complete when decision-ready.`;
	}
	if (state.savedRoast) return "A roast is saved for later.";
	if (state.activeImplementation) return "An implementation roast is active.";
	return "Roast mode is off.";
}

function formatStatus(state: RoastModeState) {
	if (state.enabled) {
		if (state.awaitingAction || state.latestRoast) return "roast ready";
		return "roast active";
	}
	if (state.savedRoast) return "roast saved";
	if (state.activeImplementation) return "roast implementing";
	return undefined;
}
