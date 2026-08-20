import { ROAST_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import type { ActiveImplementationRoast } from "./state.js";

const ROAST_CONTEXT_MESSAGE_TYPE = "roast-mode-context";
export const ROAST_IMPLEMENTATION_CONTEXT_MESSAGE_TYPE = "roast-mode-implementation-context";
const PROPOSED_ROAST_MESSAGE_TYPE = "proposed-roast";
const ROAST_IMPLEMENTATION_HANDOFF_PREFIX =
	"Roast mode is now disabled. Full tool access is restored. Implement this proposed roast now:";
const PROPOSED_ROAST_PATTERN =
	/^<proposed_roast>[\t ]*\r?\n([\s\S]*?)\r?\n<\/proposed_roast>[\t ]*$/gm;
const PROPOSED_ROAST_BLOCK_PATTERN =
	/^<proposed_roast>[\t ]*\r?\n[\s\S]*?\r?\n<\/proposed_roast>[\t ]*$/gm;

export type ProposedRoastParseResult =
	| { kind: "absent" }
	| { kind: "valid"; roast: string }
	| { kind: "empty" }
	| { kind: "multiple" }
	| { kind: "malformed" }
	| { kind: "unclosed" };

type SessionMessage = {
	role?: string;
	content?: unknown;
};

type TextBlock = {
	type?: string;
	text?: string;
};

export function parseProposedRoast(text: string): ProposedRoastParseResult {
	const openingCount = text.match(/<proposed_roast>/gi)?.length ?? 0;
	const closingCount = text.match(/<\/proposed_roast>/gi)?.length ?? 0;
	if (openingCount === 0 && closingCount === 0) return { kind: "absent" };
	if (openingCount > 1 || closingCount > 1) return { kind: "multiple" };
	if (openingCount === 1 && closingCount === 0) return { kind: "unclosed" };
	if (openingCount !== 1 || closingCount !== 1) return { kind: "malformed" };

	const matches = Array.from(text.matchAll(PROPOSED_ROAST_PATTERN));
	if (matches.length !== 1) return { kind: "malformed" };
	const roast = matches[0]?.[1]?.trim() ?? "";
	return roast ? { kind: "valid", roast } : { kind: "empty" };
}

export function extractProposedRoast(text: string) {
	const result = parseProposedRoast(text);
	return result.kind === "valid" ? result.roast : undefined;
}

export function invalidRoastMessage(kind: "empty" | "multiple" | "malformed" | "unclosed") {
	const detail = {
		empty: "the block is empty",
		multiple: "more than one roast block was produced",
		malformed: "the tags must be on their own lines",
		unclosed: "the closing tag is missing",
	}[kind];
	return `Proposed roast is not ready: ${detail}. Continue Roast mode and produce one complete non-empty <proposed_roast> block.`;
}

export function latestAssistantText(messages: unknown) {
	if (!Array.isArray(messages)) return "";
	for (const entry of [...messages].reverse()) {
		const message = (entry as { message?: SessionMessage })?.message ?? (entry as SessionMessage);
		if (message?.role !== "assistant") continue;
		const text = messageText(message);
		if (text) return text;
	}
	return "";
}

export function messageContainsLegacyRoastModeContextArtifact(message: unknown) {
	return unwrapSessionMessage(message).customType === ROAST_CONTEXT_MESSAGE_TYPE;
}

export function messageContainsRoastModeImplementationContextArtifact(message: unknown) {
	return unwrapSessionMessage(message).customType === ROAST_IMPLEMENTATION_CONTEXT_MESSAGE_TYPE;
}

export function injectActiveImplementationContext(
	messages: unknown[],
	activeImplementation: ActiveImplementationRoast,
) {
	let foundCurrentHandoff = false;
	const messagesWithoutStaleContext = messages.filter((message) => {
		if (messageContainsRoastModeImplementationContextArtifact(message)) return false;
		if (!messageContainsRoastModeImplementationHandoff(message)) return true;
		if (
			!foundCurrentHandoff &&
			messageContainsExactRoastModeImplementationHandoff(message, activeImplementation.roast)
		) {
			foundCurrentHandoff = true;
			return true;
		}
		return false;
	});
	if (foundCurrentHandoff) return messagesWithoutStaleContext;

	let insertionIndex = 0;
	while (isSummaryMessage(messagesWithoutStaleContext[insertionIndex])) insertionIndex += 1;
	const contextMessage = {
		role: "custom" as const,
		customType: ROAST_IMPLEMENTATION_CONTEXT_MESSAGE_TYPE,
		content: `[ACTIVE IMPLEMENTATION ROAST]\n\nThe user approved the exact implementation roast below. Continue following it until the user explicitly clears or supersedes it. The exact roast is the remainder of this message:\n\n${activeImplementation.roast}`,
		display: false,
		timestamp: activeImplementation.startedAt,
	};
	return [
		...messagesWithoutStaleContext.slice(0, insertionIndex),
		contextMessage,
		...messagesWithoutStaleContext.slice(insertionIndex),
	];
}

export function messageContainsInactiveRoastModeArtifact(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return (
		candidate.customType === PROPOSED_ROAST_MESSAGE_TYPE ||
		(candidate.role === "toolResult" && candidate.toolName === ROAST_MODE_COMPLETE_TOOL_NAME)
	);
}

export function messageContainsRoastModeImplementationHandoff(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return (
		candidate.role === "user" &&
		contentText(candidate.content).trimStart().startsWith(ROAST_IMPLEMENTATION_HANDOFF_PREFIX)
	);
}

export function messageContainsExactRoastModeImplementationHandoff(
	message: unknown,
	roast: string,
) {
	const candidate = unwrapSessionMessage(message);
	if (candidate.role !== "user") return false;
	return (
		contentText(candidate.content).trim() ===
		`${ROAST_IMPLEMENTATION_HANDOFF_PREFIX}\n\n${roast}`.trim()
	);
}

function isSummaryMessage(message: unknown) {
	const role = unwrapSessionMessage(message)?.role;
	return role === "compactionSummary" || role === "branchSummary";
}

export function stripProposedRoastBlocksFromMessage<T>(message: T): T {
	return replaceAssistantContent(message, stripProposedRoastBlocksFromContent);
}

export function stripRoastModeCompletionCallsFromMessage<T>(message: T): T {
	return replaceAssistantContent(message, (content) => {
		if (!Array.isArray(content)) return content;
		const nextContent = content.filter((block) => {
			const candidate = block as { type?: string; name?: string };
			return !(candidate.type === "toolCall" && candidate.name === ROAST_MODE_COMPLETE_TOOL_NAME);
		});
		return nextContent.length === content.length ? content : nextContent;
	});
}

export function isEmptyAssistantMessage(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return (
		candidate.role === "assistant" &&
		Array.isArray(candidate.content) &&
		candidate.content.length === 0
	);
}

function replaceAssistantContent<T>(message: T, transform: (content: unknown) => unknown): T {
	const candidate = unwrapSessionMessage(message);
	if (candidate.role !== "assistant") return message;

	const content = transform(candidate.content);
	if (content === candidate.content) return message;

	if (isSessionMessageEntry(message)) {
		return { ...message, message: { ...candidate, content } };
	}
	return { ...candidate, content } as T;
}

function unwrapSessionMessage(message: unknown) {
	const entry = message as { message?: unknown } | null | undefined;
	return (entry?.message ?? message ?? {}) as {
		role?: string;
		customType?: string;
		toolName?: string;
		content?: unknown;
	};
}

function isSessionMessageEntry<T>(message: T): message is T & { message: SessionMessage } {
	return typeof message === "object" && message !== null && "message" in message;
}

function stripProposedRoastBlocksFromContent(content: unknown) {
	if (typeof content === "string") return stripProposedRoastBlocks(content);
	if (!Array.isArray(content)) return content;

	let changed = false;
	const nextContent = content.map((block) => {
		const textBlock = block as TextBlock;
		if (textBlock.type !== "text" || typeof textBlock.text !== "string") return block;

		const text = stripProposedRoastBlocks(textBlock.text);
		if (text === textBlock.text) return block;

		changed = true;
		return { ...textBlock, text };
	});
	return changed ? nextContent : content;
}

export function stripProposedRoastBlocks(text: string) {
	return text.replace(PROPOSED_ROAST_BLOCK_PATTERN, "");
}

function messageText(message: SessionMessage) {
	return contentText(message.content);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const textBlock = block as TextBlock;
			return textBlock.type === "text" && typeof textBlock.text === "string" ? textBlock.text : "";
		})
		.filter(Boolean)
		.join("\n");
}
