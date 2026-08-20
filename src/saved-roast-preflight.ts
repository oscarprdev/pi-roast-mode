import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function savedRoastBlocksNewWorkflow(ctx: ExtensionContext, hasSavedRoast: boolean) {
	if (!hasSavedRoast) return false;
	const message =
		"A roast is saved for later. Implement or clear it before starting another Roast-mode workflow.";
	if (!ctx.hasUI) throw new Error(message);
	ctx.ui.notify(message, "warning");
	return true;
}

export async function preflightSavedRoastImplementation(
	ctx: ExtensionContext,
	isCurrent: () => boolean,
) {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw new Error(
			"Saved roast implementation is unavailable in print/JSON mode. Use TUI or RPC.",
		);
	}
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("Unable to implement saved roast: no model is selected.", "warning");
		return false;
	}
	let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error: unknown) {
		if (!isCurrent()) return false;
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Unable to implement saved roast: ${detail}`, "error");
		return false;
	}
	if (!isCurrent()) return false;
	if (!auth.ok) {
		ctx.ui.notify(`Unable to implement saved roast: ${auth.error}`, "warning");
		return false;
	}
	return true;
}
