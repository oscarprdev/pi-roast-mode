import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeRoastArguments } from "./command.js";
import {
	normalizeRoastModeCompletion,
	ROAST_MODE_COMPLETE_PARAMS,
	ROAST_MODE_COMPLETE_TOOL_NAME,
	renderRoastModeCompletion,
	roastModeCompleted,
} from "./completion-tool.js";
import {
	isStaleExtensionContextError,
	onAgentSettled,
	setRoastThinkingLevel,
} from "./extension-runtime.js";
import {
	formatImplementationHandoff,
	startFreshImplementationFromState,
} from "./fresh-implementation.js";
import {
	createImplementationRetentionCoordinator,
	implementationRetentionPreview,
} from "./implementation-retention.js";
import {
	invalidRoastMessage,
	latestAssistantText,
	parseProposedRoast,
} from "./message-transform.js";
import {
	clearRoastModeUi,
	roastModeStatusText as formatRoastModeStatusText,
	showStoredRoast,
	updateRoastModeUi,
} from "./presentation.js";
import { buildRoastModePrompt } from "./prompt.js";
import {
	answerRoastModeQuestions,
	normalizeRoastModeQuestionParams,
	ROAST_MODE_QUESTION_PARAMS,
	ROAST_MODE_QUESTION_TOOL_NAME,
	roastModeQuestionCancelled,
} from "./question-tool.js";
import { withoutRequiredRoastModeTools, withRequiredRoastModeTools } from "./required-tools.js";
import { createRoastActionController } from "./roast-action-controller.js";
import { createRoastExportController } from "./roast-export-controller.js";
import {
	preflightSavedRoastImplementation,
	savedRoastBlocksNewWorkflow,
} from "./saved-roast-preflight.js";
import {
	awaitRoastModeSettingsWrites,
	configuredImplementationRoastRetention,
	configuredRoastModeToggleShortcut,
	configuredRoastStyle,
	configuredThinkingLevel,
	type RoastModeSettings,
	readRoastModeSettings,
	roastModeSettingsPath,
} from "./settings.js";
import { type RoastCompletionSource, type RoastModeState, restoreRoastModeState } from "./state.js";
import {
	canSelectToolInRoastMode,
	classifyRoastModeTool,
	findBlockedCommandSegment,
	readCommand,
} from "./tool-policy.js";
import {
	compareTools,
	filterAvailableSelectedToolNames,
	snapshotRoastModeSelectedNames,
	snapshotRoastModeToolNames,
	toolPolicyLabel,
} from "./tool-selection.js";

const STATE_ENTRY_TYPE = "roast-mode-state";
const PROPOSED_ROAST_MESSAGE_TYPE = "proposed-roast";
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
interface ReadyPresentationIntent {
	nonce: number;
	roast: string;
	source: RoastCompletionSource;
}
type InteractiveUi = typeof import("./interactive-ui.js");

interface RoastModeDependencies {
	readSettings?(): ReturnType<typeof readRoastModeSettings>;
	settingsPath?: string;
	loadInteractiveUi?(): Promise<InteractiveUi>;
}
export default function roastMode(pi: ExtensionAPI, dependencies: RoastModeDependencies = {}) {
	let interactiveUiPromise: Promise<InteractiveUi> | undefined;
	const loadInteractiveUi = () => {
		if (dependencies.loadInteractiveUi) return dependencies.loadInteractiveUi();
		if (!interactiveUiPromise) {
			interactiveUiPromise = import("./interactive-ui.js").catch((error) => {
				interactiveUiPromise = undefined;
				throw error;
			});
		}
		return interactiveUiPromise;
	};
	const explicitRoastModeSettingsPath = dependencies.settingsPath;
	let state: RoastModeState = { enabled: false, awaitingAction: false };
	let settings: RoastModeSettings = { thinkingLevel: "inherit" };
	let toggleShortcut: ReturnType<typeof configuredRoastModeToggleShortcut>;
	const clearRoastModeShortcutHandler = () => {};
	let previousTools: string[] | undefined;
	let readyPresentationIntent: ReadyPresentationIntent | undefined;
	let latestCommandContext: ExtensionCommandContext | undefined;
	let nextReadyPresentationNonce = 0;
	let menuGeneration = 0;
	let workflowGeneration = 0;
	let refreshStateBeforeFirstAgentStart = false;
	let menuController = new AbortController();
	let settingsWatch: ReturnType<typeof watch> | undefined;
	let settingsReloadTimer: ReturnType<typeof setTimeout> | undefined;
	const implementationRetention = createImplementationRetentionCoordinator();
	const persistState = () => pi.appendEntry<RoastModeState>(STATE_ENTRY_TYPE, state);
	const roastExports = createRoastExportController({
		getState: () => state,
		getSettings: () => settings,
		finishReady: (ctx) => exitRoastMode(ctx),
	});
	const roastActions = createRoastActionController({
		loadInteractiveUi,
		getState: () => state,
		captureLifecycle: captureMenuLifecycle,
		statusText: roastStatusText,
		implementationOutcome,
		getExportDestination: (ctx) => roastExports.getDestination(ctx),
		show: (ctx) => showStoredRoast(pi, ctx, state),
		finalize: requestFinalRoast,
		implementHere: startImplementation,
		implementFresh: startFreshImplementation,
		exportRoast: (ctx, path, signal, isCurrent) =>
			roastExports.export(path, ctx, signal, isCurrent),
		settings: showSettings,
		save: saveRoastForLater,
		stay: updateUi,
		exitReady: (ctx) => {
			exitRoastMode(ctx);
			ctx.ui.notify("Roast mode disabled. Proposed roast discarded.", "info");
		},
		clearSaved: (ctx) => {
			exitRoastMode(ctx);
			ctx.ui.notify("Saved roast cleared.", "info");
		},
	});

	pi.registerFlag("roast", {
		description: "Start in Roast mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: ROAST_MODE_QUESTION_TOOL_NAME,
		label: "Roast question",
		description:
			"Ask the user one to three Roast-mode clarification questions with meaningful options, then wait for the answer. Only available while Roast mode is active.",
		promptSnippet: "Ask user decision questions while Roast mode is active",
		promptGuidelines: [
			"In Roast mode, use roast_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: ROAST_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return roastModeQuestionCancelled(
					[],
					"roast_mode_inactive",
					"Error: roast_mode_question is only available while Roast mode is active.",
				);
			}
			state = { ...state, askedQuestions: true };
			persistState();

			const parsed = normalizeRoastModeQuestionParams(params);
			if (!parsed.ok) {
				return roastModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}

			if (!ctx.hasUI) {
				return roastModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Roast-mode questions because interactive UI is not available.",
				);
			}

			const sessionGeneration = menuGeneration;
			const questionWorkflowGeneration = workflowGeneration;
			return answerRoastModeQuestions(parsed.questions, ctx, {
				isCurrent: () =>
					sessionGeneration === menuGeneration && questionWorkflowGeneration === workflowGeneration,
				isEnabled: () => state.enabled,
			});
		},
	});

	pi.registerTool({
		name: ROAST_MODE_COMPLETE_TOOL_NAME,
		label: "Complete roast",
		description:
			"Submit the complete decision-ready implementation roast for user review. Only available while Roast mode is active, and must be the final standalone action.",
		promptSnippet: "Submit the final Roast-mode implementation roast",
		promptGuidelines: [
			"Call roast_mode_complete alone as the final action only after the implementation roast is decision-complete.",
		],
		parameters: ROAST_MODE_COMPLETE_PARAMS,
		renderResult: renderRoastModeCompletion,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				throw new Error("roast_mode_complete is only available while Roast mode is active");
			}
			if (requiresLinusQuestions()) {
				throw new Error(
					"Linus mode requires roast_mode_question before roast_mode_complete. Ask 1-3 questions about the highest-impact findings first.",
				);
			}
			const parsed = normalizeRoastModeCompletion(params);
			if (!parsed.ok) throw new Error(parsed.error);

			acceptCompletedRoast(parsed.roast, ROAST_MODE_COMPLETE_TOOL_NAME, ctx);
			return roastModeCompleted(parsed.roast);
		},
	});

	pi.registerCommand("roast", {
		description: "Enter or manage Roast mode",
		getArgumentCompletions: completeRoastArguments,
		handler: async (args, ctx) => {
			latestCommandContext = ctx;
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "start") {
				if (savedRoastBlocksNewWorkflow(ctx, state.savedRoast !== undefined && !state.enabled))
					return;
				if (state.enabled) {
					ctx.ui.notify("Roast mode is already active.", "info");
					return;
				}
				enterRoastMode(ctx);
				ctx.ui.notify(
					"Roast mode enabled. I will explore and roast, but not modify files.",
					"info",
				);
				return;
			}
			if (command === "show") {
				showStoredRoast(pi, ctx, state);
				return;
			}
			if (command === "finalize") {
				requestFinalRoast(ctx);
				return;
			}
			if (command === "implement") {
				if (!(state.enabled && state.latestRoast?.trim()) && !state.savedRoast?.roast.trim()) {
					ctx.ui.notify("No completed roast is available to implement.", "warning");
					return;
				}
				await startImplementation(ctx);
				return;
			}
			if (command === "save") {
				saveRoastForLater(ctx);
				return;
			}
			const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(prompt);
			if (exportMatch) {
				const lifecycle = captureMenuLifecycle();
				await roastExports.export(exportMatch[1], ctx, lifecycle.signal, lifecycle.isCurrent);
				return;
			}
			if (command === "exit" || command === "off") {
				ctx.ui.notify(roastModeDisableNotification(), "info");
				exitRoastMode(ctx);
				return;
			}
			if (command === "tools") {
				if (savedRoastBlocksNewWorkflow(ctx, state.savedRoast !== undefined && !state.enabled))
					return;
				if (state.enabled) {
					const message =
						"Roast-mode tools are locked while Roasting is active. Exit Roast mode and choose tools before starting again.";
					if (!ctx.hasUI) throw new Error(message);
					ctx.ui.notify(message, "warning");
					return;
				}
				if (!ctx.hasUI) {
					throw new Error("/roast tools requires TUI or RPC mode and is unavailable here.");
				}
				await showLaunchMenu(ctx, "tools");
				return;
			}
			if (prompt) {
				if (savedRoastBlocksNewWorkflow(ctx, state.savedRoast !== undefined && !state.enabled))
					return;
				enterRoastModeWithPrompt(prompt, ctx);
				return;
			}
			if (!ctx.hasUI) {
				throw new Error(
					"The interactive /roast menu is unavailable in print and JSON modes. Use /roast start or /roast <prompt>.",
				);
			}
			if (!state.enabled) {
				if (state.activeImplementation && ctx.hasUI) {
					await showActiveRoastMenu(ctx);
					return;
				}
				if (state.savedRoast) {
					await roastActions.showSaved(ctx);
					return;
				}
				await showLaunchMenu(ctx);
				return;
			}
			await roastActions.showCurrent(ctx);
		},
	});

	const applyRoastModeShortcut = (
		nextShortcut: ReturnType<typeof configuredRoastModeToggleShortcut>,
	) => {
		if (toggleShortcut && toggleShortcut !== nextShortcut) {
			pi.registerShortcut(toggleShortcut, {
				handler: clearRoastModeShortcutHandler,
			});
		}
		if (!nextShortcut) {
			toggleShortcut = undefined;
			return;
		}
		if (toggleShortcut === nextShortcut) return;
		pi.registerShortcut(nextShortcut, {
			description: "Toggle Roast mode",
			handler: (ctx) => {
				toggleRoastMode(ctx);
			},
		});
		toggleShortcut = nextShortcut;
	};

	const readRoastModeRuntimeSettings = async () => {
		return dependencies.readSettings?.() ?? readRoastModeSettings(explicitRoastModeSettingsPath);
	};

	const applyRoastModeSettings = async (
		generation: number,
		ctx: ExtensionContext | undefined,
		showWarnings: boolean,
	) => {
		const loadedSettings = await readRoastModeRuntimeSettings();
		if (generation !== menuGeneration || menuController.signal.aborted) {
			return undefined;
		}
		if (loadedSettings.kind === "loaded") {
			settings = loadedSettings.settings;
		} else {
			settings = { thinkingLevel: "inherit" };
		}
		applyRoastModeShortcut(configuredRoastModeToggleShortcut(settings));
		if (!ctx || !showWarnings) return loadedSettings;
		if (loadedSettings.kind === "invalid") {
			ctx.ui.notify(`pi-roast-mode settings ignored: ${loadedSettings.reason}`, "warning");
		}
		if (loadedSettings.notice) {
			ctx.ui.notify(loadedSettings.notice, "warning");
		}
		return loadedSettings;
	};

	const stopRoastModeSettingsWatch = () => {
		if (settingsReloadTimer) {
			clearTimeout(settingsReloadTimer);
			settingsReloadTimer = undefined;
		}
		settingsWatch?.close();
		settingsWatch = undefined;
	};

	const scheduleRoastModeSettingsReload = (generation: number) => {
		if (settingsReloadTimer) {
			clearTimeout(settingsReloadTimer);
			settingsReloadTimer = undefined;
		}
		settingsReloadTimer = setTimeout(() => {
			settingsReloadTimer = undefined;
			void applyRoastModeSettings(generation, undefined, false);
		}, 75);
	};

	const startRoastModeSettingsWatch = (generation: number) => {
		stopRoastModeSettingsWatch();
		if (dependencies.readSettings) return;
		const pathToWatch = explicitRoastModeSettingsPath ?? roastModeSettingsPath();
		try {
			const directory = dirname(pathToWatch);
			const fileName = basename(pathToWatch);
			const watcher = watch(directory, { persistent: false }, (event, changedFile) => {
				if (event !== "rename" && event !== "change") return;
				if (!changedFile || changedFile.toString() !== fileName) return;
				scheduleRoastModeSettingsReload(generation);
			});
			watcher.on("error", () => {
				stopRoastModeSettingsWatch();
			});
			settingsWatch = watcher;
		} catch {
			stopRoastModeSettingsWatch();
		}
	};

	pi.on("session_start", async (event, ctx) => {
		const generation = ++menuGeneration;
		refreshStateBeforeFirstAgentStart = event.reason === "new";
		menuController.abort(new DOMException("Roast-mode session replaced", "AbortError"));
		menuController = new AbortController();
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		implementationRetention.reset();
		settings = { thinkingLevel: "inherit" };
		restoreState(ctx);
		implementationRetention.restore(state.activeImplementation);
		await applyRoastModeSettings(generation, ctx, true);
		if (generation !== menuGeneration || menuController.signal.aborted) return;
		startRoastModeSettingsWatch(generation);
		const persistFlagActivation = pi.getFlag("roast") === true && !state.enabled;
		if (persistFlagActivation) {
			state = state.savedRoast
				? {
						...state,
						enabled: true,
						latestRoast: state.savedRoast.roast,
						latestRoastSource: state.savedRoast.source,
						awaitingAction: true,
						askedQuestions: false,
						savedRoast: undefined,
						activeImplementation: undefined,
					}
				: { ...state, enabled: true, activeImplementation: undefined, askedQuestions: false };
		}
		if (state.enabled) {
			activateRoastModeTools();
			applyRoastThinkingLevel();
		} else deactivateRoastModeQuestionTool();
		if (persistFlagActivation) persistState();
		updateUi(ctx);
	});

	pi.on("thinking_level_select", (event) => {
		if (!state.enabled || !state.appliedThinkingLevel) return;
		if (event.level !== state.appliedThinkingLevel) {
			state = {
				...state,
				manualThinkingLevel: event.level,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			persistState();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		menuGeneration += 1;
		menuController.abort(new DOMException("Roast-mode session shut down", "AbortError"));
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		refreshStateBeforeFirstAgentStart = false;
		implementationRetention.reset();
		await awaitRoastModeSettingsWrites(dependencies.settingsPath);
		captureManualThinkingLevel();
		persistState();
		if (state.enabled) {
			restoreTools();
			restoreThinkingLevel();
		}
		stopRoastModeSettingsWatch();
		clearUi(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (event.toolName === "update_plan") {
			return {
				block: true,
				reason:
					"Roast mode blocks update_plan because it tracks execution progress rather than conversational roasting.",
			};
		}
		const calledTool = toolByName(event.toolName);
		if (calledTool && classifyRoastModeTool(calledTool) === "blocked") {
			return {
				block: true,
				reason: `Roast mode blocks built-in tool '${event.toolName}' because its policy class is blocked.`,
			};
		}
		if (!calledTool && BLOCKED_BUILTIN_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Roast mode blocks built-in tool '${event.toolName}' because its metadata is unavailable.`,
			};
		}
		// Built-in-compatible overrides retain the canonical name but replace its source metadata.
		if (event.toolName !== "bash") return;

		const blocked = findBlockedCommandSegment(readCommand(event.input), settings.safeSubcommands);
		if (blocked !== undefined) {
			return {
				block: true,
				reason: `Roast mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: ${blocked}`,
			};
		}
	});

	pi.on("context", async (event, ctx) => {
		const result = implementationRetention.transformContext(event.messages, state);
		if (result.clearActiveImplementationId) {
			clearActiveImplementation(result.clearActiveImplementationId, ctx);
		}
		return { messages: result.messages as typeof event.messages };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (refreshStateBeforeFirstAgentStart) {
			refreshStateBeforeFirstAgentStart = false;
			restoreState(ctx);
			implementationRetention.reset();
			implementationRetention.restore(state.activeImplementation);
			if (state.enabled) {
				activateRoastModeTools();
				applyRoastThinkingLevel();
			} else deactivateRoastModeQuestionTool();
			updateUi(ctx);
		}
		if (!state.enabled) return;
		if (state.latestRoast || state.awaitingAction) {
			readyPresentationIntent = undefined;
			state = {
				...state,
				latestRoast: undefined,
				latestRoastSource: undefined,
				awaitingAction: false,
				askedQuestions: false,
			};
			persistState();
			updateUi(ctx);
		}
		applyRoastModeTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildRoastModePrompt(configuredRoastStyle(settings))}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled) return;

		const text = latestAssistantText(event.messages);
		const parsedRoast = parseProposedRoast(text);
		if (parsedRoast.kind !== "valid") {
			if (parsedRoast.kind !== "absent") {
				ctx.ui.notify(invalidRoastMessage(parsedRoast.kind), "warning");
			}
			persistState();
			updateUi(ctx);
			return;
		}
		if (requiresLinusQuestions()) {
			ctx.ui.notify(
				"Linus mode requires roast_mode_question before completing the roast. Ask 1-3 questions about the highest-impact findings first.",
				"warning",
			);
			persistState();
			updateUi(ctx);
			return;
		}
		acceptCompletedRoast(parsedRoast.roast, "legacy_proposed_roast", ctx);
	});

	onAgentSettled(pi, async (_event, ctx) => {
		const settledImplementationId = implementationRetention.implementationSettled(
			state.activeImplementation,
		);
		if (settledImplementationId) clearActiveImplementation(settledImplementationId, ctx);

		const intent = readyPresentationIntent;
		if (!intent || !readyPresentationIsCurrent(intent)) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		readyPresentationIntent = undefined;
		try {
			if (intent.source === "legacy_proposed_roast") {
				pi.sendMessage(
					{
						customType: PROPOSED_ROAST_MESSAGE_TYPE,
						content: `**Proposed Roast**\n\n${intent.roast}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
			if (ctx.hasUI && completedRoastIsCurrent(intent)) {
				await roastActions.showReady(latestCommandContext ?? ctx);
			}
		} catch (error: unknown) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});

	function enterRoastMode(ctx: ExtensionContext) {
		workflowGeneration += 1;
		if (!state.enabled) previousTools = withoutRequiredRoastModeTools(safeGetActiveTools());
		state = {
			...state,
			enabled: true,
			awaitingAction: false,
			askedQuestions: false,
			savedRoast: undefined,
			activeImplementation: undefined,
		};
		activateRoastModeTools();
		applyRoastThinkingLevel();
		persistState();
		updateUi(ctx);
	}

	function enterRoastModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const previousState = state;
		const wasEnabled = state.enabled;
		enterRoastMode(ctx);
		if (!wasEnabled) {
			ctx.ui.notify("Roast mode enabled. I will explore and roast, but not modify files.", "info");
		}
		if (sendRoastModeUserMessage(prompt, ctx)) return;
		if (!previousState.enabled) {
			restoreTools();
			restoreThinkingLevel();
		}
		state = previousState;
		persistState();
		updateUi(ctx);
	}

	function exitRoastMode(ctx: ExtensionContext) {
		workflowGeneration += 1;
		const wasEnabled = state.enabled;
		readyPresentationIntent = undefined;
		state = {
			...state,
			enabled: false,
			latestRoast: undefined,
			latestRoastSource: undefined,
			awaitingAction: false,
			askedQuestions: false,
			savedRoast: undefined,
			activeImplementation: undefined,
			manualThinkingLevel: undefined,
		};
		if (wasEnabled) {
			restoreTools();
			restoreThinkingLevel();
			state = { ...state, manualThinkingLevel: undefined };
		}
		persistState();
		updateUi(ctx);
	}

	function sendRoastModeUserMessage(message: string, ctx: ExtensionContext) {
		try {
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
			return true;
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to send Roast-mode message: ${detail}`, "error");
			return false;
		}
	}

	function acceptCompletedRoast(
		roast: string,
		source: RoastCompletionSource,
		ctx: ExtensionContext,
	) {
		const normalized = normalizeRoastModeCompletion({ roast });
		if (!normalized.ok) {
			ctx.ui.notify(`Proposed roast is not ready: ${normalized.error}.`, "warning");
			persistState();
			updateUi(ctx);
			return;
		}
		if (
			state.enabled &&
			state.awaitingAction &&
			state.latestRoast === normalized.roast &&
			state.latestRoastSource === source
		) {
			return;
		}
		state = {
			...state,
			latestRoast: normalized.roast,
			latestRoastSource: source,
			awaitingAction: true,
		};
		readyPresentationIntent = {
			nonce: ++nextReadyPresentationNonce,
			roast: normalized.roast,
			source,
		};
		persistState();
		updateUi(ctx);
	}

	function requiresLinusQuestions() {
		return configuredRoastStyle(settings) === "linus" && state.askedQuestions !== true;
	}

	function completedRoastIsCurrent(intent: ReadyPresentationIntent) {
		return (
			state.enabled &&
			state.awaitingAction &&
			state.latestRoast === intent.roast &&
			state.latestRoastSource === intent.source
		);
	}

	function readyPresentationIsCurrent(intent: ReadyPresentationIntent) {
		return completedRoastIsCurrent(intent) && readyPresentationIntent?.nonce === intent.nonce;
	}

	function toggleRoastMode(ctx: ExtensionContext) {
		if (state.enabled) {
			ctx.ui.notify(roastModeDisableNotification(), "info");
			exitRoastMode(ctx);
			return;
		}
		if (savedRoastBlocksNewWorkflow(ctx, state.savedRoast !== undefined)) return;
		enterRoastMode(ctx);
		ctx.ui.notify("Roast mode enabled. I will explore and roast, but not modify files.", "info");
	}

	function roastModeDisableNotification() {
		return state.activeImplementation
			? "Active implementation roast cleared."
			: state.savedRoast
				? "Saved roast cleared."
				: state.latestRoast
					? "Roast mode disabled. Proposed roast discarded."
					: "Roast mode disabled.";
	}

	function requestFinalRoast(ctx: ExtensionContext) {
		if (!state.enabled) {
			ctx.ui.notify("Roast mode is not active. Use /roast first.", "warning");
			return;
		}
		sendRoastModeUserMessage(
			"Finalize the current implementation roast now. If any material decision remains, use roast_mode_question instead. Otherwise call roast_mode_complete alone as your final action with the complete decision-ready roast.",
			ctx,
		);
	}

	function saveRoastForLater(ctx: ExtensionContext) {
		const roast = state.enabled ? state.latestRoast?.trim() : undefined;
		if (!roast) {
			const message = "No completed roast is available to save.";
			if (!ctx.hasUI) throw new Error(message);
			ctx.ui.notify(message, "warning");
			return;
		}
		const source = state.latestRoastSource ?? "legacy_proposed_roast";

		workflowGeneration += 1;
		readyPresentationIntent = undefined;
		state = {
			...state,
			enabled: false,
			latestRoast: undefined,
			latestRoastSource: undefined,
			awaitingAction: false,
			savedRoast: { roast, source },
			activeImplementation: undefined,
			manualThinkingLevel: undefined,
		};
		restoreTools();
		restoreThinkingLevel();
		state = { ...state, manualThinkingLevel: undefined };
		persistState();
		updateUi(ctx);
		ctx.ui.notify("Roast saved for later. Roast mode disabled.", "info");
	}

	async function startFreshImplementation(ctx: ExtensionContext, menuIsCurrent: () => boolean) {
		await startFreshImplementationFromState(ctx, {
			getState: () => state,
			menuIsCurrent,
			retention: configuredImplementationRoastRetention(settings),
			stateEntryType: STATE_ENTRY_TYPE,
		});
	}

	async function startImplementation(ctx: ExtensionContext) {
		const savedRoast = state.enabled ? undefined : state.savedRoast;
		if (savedRoast) {
			const sessionGeneration = menuGeneration;
			const roastWorkflowGeneration = workflowGeneration;
			const isCurrent = () =>
				sessionGeneration === menuGeneration &&
				roastWorkflowGeneration === workflowGeneration &&
				!menuController.signal.aborted &&
				!state.enabled &&
				state.savedRoast === savedRoast;
			if (!(await preflightSavedRoastImplementation(ctx, isCurrent))) return;
		}
		const roast = (state.enabled ? state.latestRoast : savedRoast?.roast)?.trim();
		const source =
			(state.enabled ? state.latestRoastSource : savedRoast?.source) ?? "legacy_proposed_roast";
		if (!roast) {
			ctx.ui.notify("Roast mode disabled. No proposed roast is available to implement.", "warning");
			return;
		}

		workflowGeneration += 1;
		const previousState = state;
		const wasEnabled = state.enabled;
		readyPresentationIntent = undefined;
		state = {
			...state,
			enabled: false,
			latestRoast: undefined,
			latestRoastSource: undefined,
			awaitingAction: false,
			savedRoast: undefined,
			activeImplementation: {
				id: randomUUID(),
				roast,
				source,
				startedAt: Date.now(),
				retention: configuredImplementationRoastRetention(settings),
			},
			manualThinkingLevel: undefined,
		};
		if (wasEnabled) {
			restoreTools();
			restoreThinkingLevel();
			state = { ...state, manualThinkingLevel: undefined };
		}
		persistState();
		updateUi(ctx);

		const sent = sendRoastModeUserMessage(formatImplementationHandoff(roast), ctx);
		if (!sent) {
			if (savedRoast) {
				state = previousState;
			} else {
				enterRoastMode(ctx);
				state = previousState;
				applyRoastThinkingLevel();
			}
			persistState();
			updateUi(ctx);
		}
	}

	function clearActiveImplementation(id: string, ctx: ExtensionContext) {
		if (state.activeImplementation?.id !== id) return false;
		workflowGeneration += 1;
		state = { ...state, activeImplementation: undefined };
		persistState();
		updateUi(ctx);
		return true;
	}

	async function showLaunchMenu(ctx: ExtensionContext, initialScreen: "main" | "tools" = "main") {
		const lifecycle = captureMenuLifecycle();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		const tools = selectableTools();
		await ui.showRoastLaunchMenu(ctx, {
			statusText: "Status: Off — normal tools are active.",
			initialScreen,
			getSelectedNames: () => snapshotRoastModeSelectedNames(tools, toolSelectionSnapshot()),
			toolSummary: (selectedNames) =>
				`When started: ${snapshotRoastModeToolNames(tools, selectedNames, toolSelectionSnapshot()).join(", ")}`,
			tools: tools.map((tool) => {
				const selectable = canSelectToolInRoastMode(tool);
				const policy = toolPolicyLabel(tool);
				const description = tool.description ?? "No description available";
				return {
					name: tool.name,
					description: `${policy} · ${description}`,
					searchText: [policy, description].join(" "),
					disabled: !selectable,
					disabledReason: selectable ? undefined : "Blocked by Roast-mode policy",
				};
			}),
			...lifecycle,
			start: (signal) => {
				if (signal.aborted || !lifecycle.isCurrent()) return;
				enterRoastMode(ctx);
				ctx.ui.notify(
					"Roast mode enabled. I will explore and roast, but not modify files.",
					"info",
				);
			},
			startWithTools: (names, signal) => {
				if (signal.aborted || !lifecycle.isCurrent()) return;
				state = {
					...state,
					selectedToolNames: filterAvailableSelectedToolNames(names, tools),
					selectedToolKeys: undefined,
				};
				enterRoastMode(ctx);
				ctx.ui.notify("Roast mode enabled with the selected tools.", "info");
			},
			settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
		});
	}

	async function showActiveRoastMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(roastStatusText(), "info");
			return;
		}
		const lifecycle = captureMenuLifecycle();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		await ui.showActiveImplementationMenu(ctx, {
			statusText: roastStatusText(),
			getExportDestination: () => roastExports.getDestination(ctx),
			signal: lifecycle.signal,
			isCurrent: lifecycle.isCurrent,
			show: () => showStoredRoast(pi, ctx, state),
			exportRoast: (path, signal) => roastExports.export(path, ctx, signal, lifecycle.isCurrent),
			settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
			startNew: () => {
				enterRoastMode(ctx);
				ctx.ui.notify(
					"Roast mode enabled. I will explore and roast, but not modify files.",
					"info",
				);
			},
			clear: () => {
				exitRoastMode(ctx);
				ctx.ui.notify("Active implementation roast cleared.", "info");
			},
		});
	}

	async function showSettings(
		ctx: ExtensionContext,
		signal: AbortSignal,
		isCurrent: () => boolean,
	) {
		if (!isCurrent() || signal.aborted) return false;
		const ui = await loadInteractiveUi();
		if (!isCurrent() || signal.aborted) return false;
		const result = await ui.showRoastModeSettings(ctx, {
			tools: selectableTools(),
			signal,
			isCurrent,
			settingsPath: dependencies.settingsPath,
			onSaved: (saved) => {
				if (!isCurrent()) return;
				settings = saved;
				applyRoastModeShortcut(configuredRoastModeToggleShortcut(saved));
			},
			...(dependencies.readSettings
				? { readSettings: async () => dependencies.readSettings?.() ?? { kind: "missing" } }
				: {}),
		});
		return result.kind === "closed" && "reason" in result && result.reason === "close";
	}

	function captureMenuLifecycle() {
		const sessionGeneration = menuGeneration;
		const roastWorkflowGeneration = workflowGeneration;
		const controller = menuController;
		return {
			signal: controller.signal,
			isCurrent: () =>
				sessionGeneration === menuGeneration &&
				roastWorkflowGeneration === workflowGeneration &&
				!controller.signal.aborted,
		};
	}

	function activateRoastModeTools() {
		previousTools ??= withoutRequiredRoastModeTools(safeGetActiveTools());
		applyRoastModeTools();
	}

	function applyRoastModeTools() {
		pi.setActiveTools(roastModeToolNames());
	}

	function roastModeToolNames() {
		const tools = selectableTools();
		if (
			tools.length === 0 &&
			state.selectedToolNames === undefined &&
			state.selectedToolKeys === undefined &&
			settings.defaultRoastTools === undefined
		) {
			return ["read", "bash", ROAST_MODE_QUESTION_TOOL_NAME, ROAST_MODE_COMPLETE_TOOL_NAME];
		}

		const selectedNames = snapshotRoastModeSelectedNames(tools, toolSelectionSnapshot());
		return withRequiredRoastModeTools(
			tools
				.filter((tool) => selectedNames.has(tool.name) && canSelectToolInRoastMode(tool))
				.map((tool) => tool.name),
		);
	}

	function toolSelectionSnapshot() {
		return {
			selectedToolNames: state.selectedToolNames,
			selectedToolKeys: state.selectedToolKeys,
			defaultRoastTools: settings.defaultRoastTools,
		};
	}

	function selectableTools() {
		return safeGetAllTools()
			.filter(
				(tool) =>
					tool.name !== ROAST_MODE_QUESTION_TOOL_NAME &&
					tool.name !== ROAST_MODE_COMPLETE_TOOL_NAME,
			)
			.sort(compareTools);
	}

	function safeGetAllTools() {
		try {
			return pi.getAllTools();
		} catch {
			return [];
		}
	}

	function restoreTools() {
		const restoredTools = previousTools ?? DEFAULT_TOOLS;
		pi.setActiveTools(withoutRequiredRoastModeTools(restoredTools));
		previousTools = undefined;
	}

	function applyRoastThinkingLevel() {
		if (state.manualThinkingLevel) {
			if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
				setRoastThinkingLevel(pi, state.manualThinkingLevel);
			}
			return;
		}
		const configured = configuredThinkingLevel(settings);
		if (!configured) {
			state = {
				...state,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			return;
		}
		const current = pi.getThinkingLevel();
		if (!state.appliedThinkingLevel) state.previousThinkingLevel = current;
		if (current !== configured) setRoastThinkingLevel(pi, configured);
		state.appliedThinkingLevel = pi.getThinkingLevel();
	}

	function captureManualThinkingLevel() {
		if (!state.appliedThinkingLevel) return;
		const current = pi.getThinkingLevel();
		if (current === state.appliedThinkingLevel) return;
		state = {
			...state,
			manualThinkingLevel: current,
			previousThinkingLevel: undefined,
			appliedThinkingLevel: undefined,
		};
	}

	function restoreThinkingLevel() {
		captureManualThinkingLevel();
		const { appliedThinkingLevel, previousThinkingLevel } = state;
		if (
			appliedThinkingLevel &&
			previousThinkingLevel &&
			pi.getThinkingLevel() === appliedThinkingLevel
		) {
			setRoastThinkingLevel(pi, previousThinkingLevel);
		}
		state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
	}

	function deactivateRoastModeQuestionTool() {
		const activeTools = safeGetActiveTools();
		const filteredTools = withoutRequiredRoastModeTools(activeTools);
		if (filteredTools.length !== activeTools.length) {
			pi.setActiveTools(filteredTools);
		}
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return DEFAULT_TOOLS;
		}
	}

	function restoreState(ctx: ExtensionContext) {
		state = restoreRoastModeState(ctx.sessionManager.getBranch(), STATE_ENTRY_TYPE);
	}

	function updateUi(ctx: ExtensionContext) {
		updateRoastModeUi(ctx, state, formatToolSummary);
	}

	function clearUi(ctx: ExtensionContext) {
		clearRoastModeUi(ctx);
	}

	function roastStatusText() {
		return formatRoastModeStatusText(state, formatToolSummary);
	}

	function implementationOutcome() {
		return implementationRetentionPreview(configuredImplementationRoastRetention(settings));
	}

	function formatToolSummary() {
		const names = roastModeToolNames();
		return `Tools: ${names.length > 0 ? names.join(", ") : "none"}`;
	}

	function toolByName(toolName: string) {
		return safeGetAllTools().find((candidate) => candidate.name === toolName);
	}
}

export { completeRoastArguments } from "./command.js";
export {
	extractProposedRoast,
	latestAssistantText,
	parseProposedRoast,
	stripProposedRoastBlocks,
	stripProposedRoastBlocksFromMessage,
} from "./message-transform.js";
export { buildRoastModePrompt } from "./prompt.js";
export { normalizeRoastModeQuestionParams } from "./question-tool.js";
export { withoutRoastModeQuestionTool, withRequiredRoastModeTools } from "./required-tools.js";
export { normalizeRoastModeSettings, readRoastModeSettings } from "./settings.js";
export { canSelectToolInRoastMode, classifyRoastModeTool, isSafeCommand } from "./tool-policy.js";
