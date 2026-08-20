import {
	injectActiveImplementationContext,
	isEmptyAssistantMessage,
	messageContainsExactRoastModeImplementationHandoff,
	messageContainsInactiveRoastModeArtifact,
	messageContainsLegacyRoastModeContextArtifact,
	messageContainsRoastModeImplementationContextArtifact,
	messageContainsRoastModeImplementationHandoff,
	stripProposedRoastBlocksFromMessage,
	stripRoastModeCompletionCallsFromMessage,
} from "./message-transform.js";
import type { ImplementationRoastRetention } from "./settings.js";
import type { ActiveImplementationRoast, RoastModeState } from "./state.js";

export function retentionLabel(retention: ImplementationRoastRetention) {
	return {
		keep: "Keep roast active",
		"clear-on-start": "Use roast for handoff only",
		"clear-after-first-run": "Clear after first implementation run",
	}[retention];
}

export function implementationRetentionPreview(retention: ImplementationRoastRetention) {
	return {
		keep: "After Implement: Keep roast active until /roast exit.",
		"clear-on-start":
			"After Implement: Use the roast for the implementation handoff only, then clear it.",
		"clear-after-first-run": "After Implement: Clear after the first implementation run settles.",
	}[retention];
}

export interface ImplementationContextResult {
	messages: unknown[];
	clearActiveImplementationId?: string;
}

export interface ImplementationRetentionCoordinator {
	restore(activeImplementation: ActiveImplementationRoast | undefined): void;
	transformContext(messages: unknown[], state: RoastModeState): ImplementationContextResult;
	implementationSettled(
		activeImplementation: ActiveImplementationRoast | undefined,
	): string | undefined;
	reset(): void;
}

export function createImplementationRetentionCoordinator(): ImplementationRetentionCoordinator {
	let implementationWithDeliveredContext: string | undefined;
	let restoredImplementationAwaitingContext: string | undefined;

	return {
		restore(activeImplementation) {
			restoredImplementationAwaitingContext =
				activeImplementation && activeImplementation.retention !== "keep"
					? activeImplementation.id
					: undefined;
		},
		transformContext(messages, state) {
			const messagesWithoutRoastContext = messages.filter(
				(message) =>
					!messageContainsLegacyRoastModeContextArtifact(message) &&
					!messageContainsRoastModeImplementationContextArtifact(message),
			);
			if (state.enabled) {
				return {
					messages: messagesWithoutRoastContext.filter(
						(message) => !messageContainsRoastModeImplementationHandoff(message),
					),
				};
			}

			const activeImplementation = state.activeImplementation;
			const inactiveMessages = activeImplementation
				? messagesWithoutRoastContext
				: messagesWithoutRoastContext.filter(
						(message) => !messageContainsRoastModeImplementationHandoff(message),
					);
			const filteredMessages = inactiveMessages
				.filter((message) => !messageContainsInactiveRoastModeArtifact(message))
				.map(stripProposedRoastBlocksFromMessage)
				.map(stripRoastModeCompletionCallsFromMessage)
				.filter((message) => !isEmptyAssistantMessage(message));
			if (!activeImplementation) return { messages: filteredMessages };

			const contextualMessages = injectActiveImplementationContext(
				filteredMessages,
				activeImplementation,
			);
			// A busy /roast implement queues its handoff behind an older run. Do not arm cleanup
			// until that exact handoff reaches context; a restored session has no older run to drain.
			const deliveredCurrentHandoff =
				restoredImplementationAwaitingContext === activeImplementation.id ||
				filteredMessages.some((message) =>
					messageContainsExactRoastModeImplementationHandoff(message, activeImplementation.roast),
				);
			if (!deliveredCurrentHandoff) return { messages: contextualMessages };
			restoredImplementationAwaitingContext = undefined;

			if (activeImplementation.retention === "clear-after-first-run") {
				implementationWithDeliveredContext = activeImplementation.id;
			}
			return {
				messages: contextualMessages,
				clearActiveImplementationId:
					activeImplementation.retention === "clear-on-start" ? activeImplementation.id : undefined,
			};
		},
		implementationSettled(activeImplementation) {
			if (
				activeImplementation?.retention !== "clear-after-first-run" ||
				implementationWithDeliveredContext !== activeImplementation.id
			) {
				return undefined;
			}
			implementationWithDeliveredContext = undefined;
			return activeImplementation.id;
		},
		reset() {
			implementationWithDeliveredContext = undefined;
			restoredImplementationAwaitingContext = undefined;
		},
	};
}
