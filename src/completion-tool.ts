import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

export const ROAST_MODE_COMPLETE_TOOL_NAME = "roast_mode_complete";
export const ROAST_MODE_COMPLETE_VERSION = 1;
export const ROAST_MODE_MAX_CHARS = 50_000;

export type RoastModeCompletionDetails = {
	version: typeof ROAST_MODE_COMPLETE_VERSION;
	source: typeof ROAST_MODE_COMPLETE_TOOL_NAME;
	roast: string;
};

export const ROAST_MODE_COMPLETE_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["roast"],
	properties: {
		roast: {
			type: "string",
			minLength: 1,
			maxLength: ROAST_MODE_MAX_CHARS,
			description: "The complete decision-ready implementation roast in Markdown.",
		},
	},
} as const;

type NormalizeRoastModeCompletionResult =
	| { ok: true; roast: string }
	| { ok: false; error: string };

export function normalizeRoastModeCompletion(input: unknown): NormalizeRoastModeCompletionResult {
	if (!isRecord(input) || typeof input.roast !== "string") {
		return { ok: false, error: "roast must be a string" };
	}
	const roast = input.roast.trim();
	if (!roast) return { ok: false, error: "roast must not be empty" };
	if (roast.length > ROAST_MODE_MAX_CHARS) {
		return {
			ok: false,
			error: `roast must not exceed ${ROAST_MODE_MAX_CHARS} characters`,
		};
	}
	return { ok: true, roast };
}

export function roastFromCompletionDetails(value: unknown) {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== ROAST_MODE_COMPLETE_VERSION ||
		value.source !== ROAST_MODE_COMPLETE_TOOL_NAME
	) {
		return undefined;
	}
	const normalized = normalizeRoastModeCompletion({ roast: value.roast });
	return normalized.ok ? normalized.roast : undefined;
}

export function roastModeCompleted(roast: string) {
	return {
		content: [{ type: "text" as const, text: `**Proposed Roast**\n\n${roast}` }],
		details: {
			version: ROAST_MODE_COMPLETE_VERSION,
			source: ROAST_MODE_COMPLETE_TOOL_NAME,
			roast,
		} satisfies RoastModeCompletionDetails,
		terminate: true,
	};
}

type RoastModeCompletionRenderResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};

export function roastModeCompletionMarkdown(result: RoastModeCompletionRenderResult) {
	const content = result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (content) return content;
	const roast = roastFromCompletionDetails(result.details);
	return roast ? `**Proposed Roast**\n\n${roast}` : "";
}

export function renderRoastModeCompletion(result: RoastModeCompletionRenderResult) {
	return new Markdown(roastModeCompletionMarkdown(result), 0, 0, getMarkdownTheme());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
