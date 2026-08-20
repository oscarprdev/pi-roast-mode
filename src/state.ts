import {
	normalizeRoastModeCompletion,
	ROAST_MODE_COMPLETE_TOOL_NAME,
	roastFromCompletionDetails,
} from "./completion-tool.js";
import {
	IMPLEMENTATION_ROAST_RETENTIONS,
	type ImplementationRoastRetention,
	ROAST_MODE_THINKING_LEVELS,
	type RoastModeFixedThinkingLevel,
} from "./settings.js";

export type RoastCompletionSource = typeof ROAST_MODE_COMPLETE_TOOL_NAME | "legacy_proposed_roast";

export interface ActiveImplementationRoast {
	id: string;
	roast: string;
	source: RoastCompletionSource;
	startedAt: number;
	retention?: ImplementationRoastRetention;
}

export interface SavedRoast {
	roast: string;
	source: RoastCompletionSource;
}

export interface RoastModeState {
	enabled: boolean;
	latestRoast?: string;
	latestRoastSource?: RoastCompletionSource;
	awaitingAction: boolean;
	askedQuestions?: boolean;
	savedRoast?: SavedRoast;
	activeImplementation?: ActiveImplementationRoast;
	selectedToolNames?: string[];
	selectedToolKeys?: string[];
	previousThinkingLevel?: RoastModeFixedThinkingLevel;
	appliedThinkingLevel?: RoastModeFixedThinkingLevel;
	manualThinkingLevel?: RoastModeFixedThinkingLevel;
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
};

export function restoreRoastModeState(entries: unknown[], stateEntryType: string): RoastModeState {
	const branch = entries as SessionEntry[];
	let stateEntryIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const candidate = branch[index];
		if (candidate?.type === "custom" && candidate.customType === stateEntryType) {
			stateEntryIndex = index;
			break;
		}
	}
	const entry = branch[stateEntryIndex];
	if (!isRecord(entry?.data)) return { enabled: false, awaitingAction: false };

	const enabled = entry.data.enabled === true;
	const persistedSource = enabled ? roastCompletionSource(entry.data.latestRoastSource) : undefined;
	const persistedRoast = enabled ? normalizePersistedRoast(entry.data.latestRoast) : undefined;
	const recoveredRoast =
		enabled && !persistedRoast
			? latestCompletionRoast(branch.slice(stateEntryIndex + 1))
			: undefined;
	const latestRoast = persistedRoast ?? recoveredRoast;
	const activeImplementation = enabled
		? undefined
		: normalizeActiveImplementation(entry.data.activeImplementation);
	const savedRoast =
		enabled || activeImplementation ? undefined : normalizeSavedRoast(entry.data.savedRoast);
	return {
		enabled,
		latestRoast,
		latestRoastSource: enabled
			? ((persistedRoast ? persistedSource : undefined) ??
				(recoveredRoast ? ROAST_MODE_COMPLETE_TOOL_NAME : undefined))
			: undefined,
		awaitingAction: enabled && latestRoast !== undefined,
		askedQuestions: entry.data.askedQuestions === true,
		savedRoast,
		activeImplementation,
		selectedToolNames: stringArray(entry.data.selectedToolNames),
		selectedToolKeys: stringArray(entry.data.selectedToolKeys),
		previousThinkingLevel: enabled
			? fixedThinkingLevel(entry.data.previousThinkingLevel)
			: undefined,
		appliedThinkingLevel: enabled ? fixedThinkingLevel(entry.data.appliedThinkingLevel) : undefined,
		manualThinkingLevel: enabled ? fixedThinkingLevel(entry.data.manualThinkingLevel) : undefined,
	};
}

function normalizeSavedRoast(value: unknown): SavedRoast | undefined {
	if (!isRecord(value)) return undefined;
	const source = roastCompletionSource(value.source);
	const normalized = normalizeRoastModeCompletion({ roast: value.roast });
	if (!source || !normalized.ok) return undefined;
	return { roast: normalized.roast, source };
}

function normalizeActiveImplementation(value: unknown): ActiveImplementationRoast | undefined {
	if (!isRecord(value)) return undefined;
	const id =
		typeof value.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.id)
			? value.id
			: undefined;
	const source = roastCompletionSource(value.source);
	const normalized = normalizeRoastModeCompletion({ roast: value.roast });
	const startedAt =
		typeof value.startedAt === "number" &&
		Number.isSafeInteger(value.startedAt) &&
		value.startedAt >= 0
			? value.startedAt
			: undefined;
	if (!id || !source || !normalized.ok || startedAt === undefined) return undefined;
	const retention = IMPLEMENTATION_ROAST_RETENTIONS.includes(
		value.retention as ImplementationRoastRetention,
	)
		? (value.retention as ImplementationRoastRetention)
		: "keep";
	return { id, roast: normalized.roast, source, startedAt, retention };
}

function normalizePersistedRoast(value: unknown) {
	const normalized = normalizeRoastModeCompletion({ roast: value });
	return normalized.ok ? normalized.roast : undefined;
}

function latestCompletionRoast(entries: SessionEntry[]) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const message = entries[index]?.message;
		if (message?.role !== "toolResult" || message.toolName !== ROAST_MODE_COMPLETE_TOOL_NAME) {
			continue;
		}
		const roast = roastFromCompletionDetails(message.details);
		if (roast) return roast;
	}
	return undefined;
}

function roastCompletionSource(value: unknown): RoastCompletionSource | undefined {
	return value === ROAST_MODE_COMPLETE_TOOL_NAME || value === "legacy_proposed_roast"
		? value
		: undefined;
}

function fixedThinkingLevel(value: unknown): RoastModeFixedThinkingLevel | undefined {
	return typeof value === "string" &&
		value !== "inherit" &&
		ROAST_MODE_THINKING_LEVELS.includes(value as (typeof ROAST_MODE_THINKING_LEVELS)[number])
		? (value as RoastModeFixedThinkingLevel)
		: undefined;
}

function stringArray(value: unknown) {
	return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
		? Array.from(new Set(value))
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
