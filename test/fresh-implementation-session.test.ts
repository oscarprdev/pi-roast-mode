import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	formatImplementationHandoff,
	startFreshImplementationFromState,
	startFreshImplementationSession,
} from "../src/fresh-implementation.js";
import { showReadyRoastMenu } from "../src/roast-action-menus.js";
import roastMode from "../src/roast-mode.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

const ROAST = `# Fresh implementation roast

1. Start from the approved roast.
2. Exclude the roasting conversation.`;
const STATE_ENTRY_TYPE = "roast-mode-state";

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom" as const, customType: STATE_ENTRY_TYPE, data };
}

async function completeRoast(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
	const complete = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { roast: ROAST }, undefined, undefined, ctx);
}

const IMPLEMENTATION_CHOICES = ["Implement here", "Start fresh and implement"];
const MISSING_SETTINGS = { readSettings: async () => ({ kind: "missing" as const }) };

function assertImplementationChoiceCopy(title: string, options: string[]) {
	assert.match(title, /Implement here keeps this roasting conversation/i);
	assert.match(title, /Start fresh transfers only the approved roast/i);
	assert.deepEqual(
		options.filter((option) => IMPLEMENTATION_CHOICES.includes(option)),
		IMPLEMENTATION_CHOICES,
	);
	assert.ok(options.length <= 8, "seven actions plus the Pi TUI Kit Close route");
}

test("automatic and manual ready menus present both implementation contexts in one flat group", async () => {
	for (const automatic of [true, false]) {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		roastMode(mock.pi, MISSING_SETTINGS);
		let observedMenu: { title: string; options: string[] } | undefined;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async (title: string, options: string[]) => {
				observedMenu = { title, options };
				return "Stay in Roast mode";
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);
		if (automatic) await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		else await mock.commands.get("roast")?.handler("", context.ctx);
		assert.ok(observedMenu);
		assertImplementationChoiceCopy(observedMenu.title, observedMenu.options);
		assert.equal(observedMenu.options.includes("Show latest proposed roast"), !automatic);
		assert.ok(observedMenu.options.includes("Discard roast and exit"));
	}
});

test("ready choice descriptions stay bounded and cancellation has no side effects", async () => {
	for (const cancel of ["tui.select.cancel", "\u0003"] as const) {
		const owner = new AbortController();
		let actionCalls = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				for (const width of [24, 40, 80]) {
					const lines = harness.render(width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
				}
				assert.match(harness.render().join("\n"), /Continue in this session/i);
				harness.handleInput("tui.select.down");
				assert.match(harness.render(40).join("\n"), /Open a new linked session/i);
				assert.match(harness.render(24).join("\n"), /Start fresh and implement/i);
				harness.handleInput(cancel);
				return harness.resultPromise;
			},
		});
		await showReadyRoastMenu(context.ctx, {
			signal: owner.signal,
			isCurrent: () => !owner.signal.aborted,
			implementationOutcome: () => "After Implement: Keep roast active\u001b]8;;unsafe\u0007.",
			getExportDestination: () => ({ configuredPath: "ROAST.md", resolvedPath: "/tmp/ROAST.md" }),
			implementHere: () => {
				actionCalls += 1;
			},
			implementFresh: () => {
				actionCalls += 1;
			},
			exportRoast: async () => {
				actionCalls += 1;
				return true;
			},
			save: () => {
				actionCalls += 1;
			},
			stay: () => {
				actionCalls += 1;
			},
			exit: () => {
				actionCalls += 1;
			},
		});
		assert.equal(actionCalls, 0);
	}
});

test("automatic completion presents the ready menu without a model turn exactly once", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi, MISSING_SETTINGS);
	let menuCount = 0;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: async () => {
			menuCount += 1;
			return "Stay in Roast mode";
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await completeRoast(mock, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);

	assert.deepEqual(mock.sentUserMessages, []);
	assert.equal(menuCount, 1);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(menuCount, 1);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("fresh selection fails closed when automatic readiness has no command context", async () => {
	const context = createMockContext({ mode: "rpc", hasUI: true });
	const state = {
		enabled: true,
		awaitingAction: true,
		latestRoast: ROAST,
		latestRoastSource: "roast_mode_complete" as const,
	};
	const result = await startFreshImplementationFromState(context.ctx, {
		getState: () => state,
		menuIsCurrent: () => true,
		retention: "keep",
		stateEntryType: STATE_ENTRY_TYPE,
	});

	assert.equal(result.kind, "rejected");
	assert.match(context.notifications.at(-1)?.message ?? "", /reopen \/roast/i);
});

test("fresh implementation creates a linked destination and hands off only through replacement context", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: {
				thinkingLevel: "inherit" as const,
				implementationRoastRetention: "clear-after-first-run" as const,
			},
		}),
	});
	const destinationEntries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const replacementMessages: string[] = [];
	let newSessionCalls = 0;
	let parentSession: string | undefined;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
		sessionManager: {
			getSessionFile: () => "/sessions/roasting.jsonl",
			getBranch: () => [],
			getEntries: () => [],
		},
		select: async (_title: string, options: string[]) =>
			options.includes("Start fresh and implement") ? "Start fresh and implement" : undefined,
		newSession: async (options: {
			parentSession?: string;
			setup?: (sessionManager: {
				appendCustomEntry(customType: string, data: unknown): string;
			}) => Promise<void>;
			withSession?: (ctx: { sendUserMessage(message: string): Promise<void> }) => Promise<void>;
		}) => {
			newSessionCalls += 1;
			parentSession = options.parentSession;
			await options.setup?.({
				appendCustomEntry(customType, data) {
					destinationEntries.push({ type: "custom", customType, data });
					return "destination-state";
				},
			});
			await options.withSession?.({
				async sendUserMessage(message) {
					replacementMessages.push(message);
				},
			});
			return { cancelled: false };
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await completeRoast(mock, context.ctx);
	const sourceEntriesBefore = mock.entries.length;
	await mock.commands.get("roast")?.handler("", context.ctx);

	assert.equal(newSessionCalls, 1);
	assert.equal(parentSession, "/sessions/roasting.jsonl");
	assert.equal(mock.entries.length, sourceEntriesBefore);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(destinationEntries.length, 1);
	const destinationState = destinationEntries[0]?.data as {
		enabled?: boolean;
		activeImplementation?: { roast?: string; retention?: string };
	};
	assert.equal(destinationState.enabled, false);
	assert.equal(destinationState.activeImplementation?.roast, ROAST);
	assert.equal(destinationState.activeImplementation?.retention, "clear-after-first-run");
	assert.equal(replacementMessages.length, 1);
	assert.match(
		replacementMessages[0] ?? "",
		/Implement this proposed roast now:[\s\S]*Fresh implementation roast/,
	);
});

test("saved roasts can start fresh without consuming the source session state", async () => {
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedRoast: { roast: ROAST, source: "roast_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi, MISSING_SETTINGS);
	let destinationState: unknown;
	let newSessionCalls = 0;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
		sessionManager: {
			getSessionFile: () => "/sessions/saved-roast.jsonl",
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
		select: async () => "Start fresh and implement",
		newSession: async (options: {
			setup?: (sessionManager: {
				appendCustomEntry(customType: string, data: unknown): string;
			}) => Promise<void>;
			withSession?: (ctx: { sendUserMessage(message: string): Promise<void> }) => Promise<void>;
		}) => {
			newSessionCalls += 1;
			await options.setup?.({
				appendCustomEntry(_customType, data) {
					destinationState = data;
					return "destination-state";
				},
			});
			await options.withSession?.({ sendUserMessage: async () => undefined });
			return { cancelled: false };
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("", context.ctx);

	assert.equal(newSessionCalls, 1);
	assert.equal(context.statuses.get("roast-mode"), "roast saved");
	assert.equal(mock.entries.length, 0);
	assert.equal(
		(destinationState as { activeImplementation?: { roast?: string } }).activeImplementation?.roast,
		ROAST,
	);
});

test("fresh menu work stops after source session shutdown while waiting for idle", async () => {
	let releaseIdle!: () => void;
	let markWaiting!: () => void;
	const waiting = new Promise<void>((resolve) => {
		markWaiting = resolve;
	});
	const idleGate = new Promise<void>((resolve) => {
		releaseIdle = resolve;
	});
	let newSessionCalls = 0;
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi, MISSING_SETTINGS);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
		select: async () => "Start fresh and implement",
		waitForIdle: async () => {
			markWaiting();
			await idleGate;
		},
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: false };
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await completeRoast(mock, context.ctx);
	const pendingMenu = mock.commands.get("roast")?.handler("", context.ctx);
	await waiting;
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "new" }, context.ctx);
	releaseIdle();
	await pendingMenu;

	assert.equal(newSessionCalls, 0);
	const persisted = mock.entries.at(-1)?.data as { latestRoast?: string };
	assert.equal(persisted.latestRoast, ROAST);
});

test("fresh destination adopts setup state before the first kickoff context for every retention", async () => {
	for (const retention of ["keep", "clear-on-start", "clear-after-first-run"] as const) {
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		roastMode(mock.pi, MISSING_SETTINGS);
		const context = createMockContext({
			sessionManager: {
				getSessionFile: () => "/sessions/implementation.jsonl",
				getBranch: () => entries,
				getEntries: () => entries,
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
		assert.equal(context.statuses.get("roast-mode"), undefined);

		entries.push(
			stateEntry({
				enabled: false,
				awaitingAction: false,
				activeImplementation: {
					id: `fresh-${retention}`,
					roast: ROAST,
					source: "roast_mode_complete",
					startedAt: 42,
					retention,
				},
			}),
		);
		const handoff = `Roast mode is now disabled. Full tool access is restored. Implement this proposed roast now:\n\n${ROAST}`;
		await mock.events.get("before_agent_start")?.[0]?.(
			{ prompt: handoff, systemPrompt: "system" },
			context.ctx,
		);
		assert.equal(context.statuses.get("roast-mode"), "roast implementing");
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);

		const firstContext = (await mock.events.get("context")?.[0]?.(
			{ messages: [{ role: "user", content: handoff }] },
			context.ctx,
		)) as { messages: unknown[] };
		assert.match(JSON.stringify(firstContext.messages), /Fresh implementation roast/);
		if (retention === "clear-on-start") {
			assert.equal(context.statuses.get("roast-mode"), undefined);
		} else {
			assert.equal(context.statuses.get("roast-mode"), "roast implementing");
		}
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		assert.equal(
			context.statuses.get("roast-mode"),
			retention === "keep" ? "roast implementing" : undefined,
		);
	}
});

test("fresh replacement reports recoverable setup and kickoff failures as partial", async () => {
	for (const failure of ["setup", "kickoff"] as const) {
		let appendedState: unknown;
		let replacementMessage = "";
		const replacement = createMockContext({ mode: "rpc", hasUI: true });
		const source = createMockContext({
			mode: "rpc",
			hasUI: true,
			model: { provider: "test-provider", id: "test-model" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
			sessionManager: { getSessionFile: () => "/sessions/roasting.jsonl" },
			newSession: async (options: {
				setup?: (sessionManager: {
					appendCustomEntry(customType: string, data: unknown): string;
				}) => Promise<void>;
				withSession?: (ctx: unknown) => Promise<void>;
			}) => {
				await options.setup?.({
					appendCustomEntry(_customType, data) {
						if (failure === "setup") throw new Error("disk\u001b[31m denied");
						appendedState = data;
						return "destination-state";
					},
				});
				await options.withSession?.({
					...(replacement.ctx as object),
					async sendUserMessage(message: string) {
						replacementMessage = message;
						if (failure === "kickoff") {
							throw new Error(`provider\u001b[31m rejected ${"x".repeat(2_000)} TAIL`);
						}
					},
				});
				return { cancelled: false };
			},
		});

		const result = await startFreshImplementationSession(source.ctx, {
			roast: ROAST,
			source: "roast_mode_complete",
			retention: "keep",
			stateEntryType: STATE_ENTRY_TYPE,
			isCurrent: () => true,
		});

		assert.equal(result.kind, "partial");
		if (failure === "setup") {
			assert.equal(appendedState, undefined);
			assert.equal(replacementMessage, "");
			assert.equal(replacement.editorText, formatImplementationHandoff(ROAST));
		} else {
			assert.ok(appendedState);
			assert.equal(replacementMessage, formatImplementationHandoff(ROAST));
		}
		assert.match(
			replacement.notifications.at(-1)?.message ?? "",
			/resume the parent roasting session/i,
		);
		const notification = replacement.notifications.at(-1)?.message ?? "";
		assert.equal(notification.includes("\u001b"), false);
		assert.ok(notification.length < 800);
		if (failure === "kickoff") assert.equal(notification.includes("TAIL"), false);
	}
});

test("fresh preflight and replacement cancellation preserve the source boundary", async () => {
	let newSessionCalls = 0;
	let current = true;
	const authFailure = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no auth" }) },
		sessionManager: { getSessionFile: () => "/sessions/roasting.jsonl" },
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: false };
		},
	});
	const request = {
		roast: ROAST,
		source: "roast_mode_complete" as const,
		retention: "keep" as const,
		stateEntryType: STATE_ENTRY_TYPE,
		isCurrent: () => current,
	};
	assert.equal((await startFreshImplementationSession(authFailure.ctx, request)).kind, "rejected");
	assert.equal(newSessionCalls, 0);

	const stale = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		waitForIdle: async () => {
			current = false;
		},
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: false };
		},
	});
	current = true;
	assert.equal((await startFreshImplementationSession(stale.ctx, request)).kind, "stale");
	assert.equal(newSessionCalls, 0);

	const cancelled = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
		sessionManager: { getSessionFile: () => "/sessions/roasting.jsonl" },
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: true };
		},
	});
	current = true;
	assert.equal((await startFreshImplementationSession(cancelled.ctx, request)).kind, "cancelled");
	assert.equal(newSessionCalls, 1);
	assert.match(cancelled.notifications.at(-1)?.message ?? "", /roast remains available/i);
});

test("saved-roast RPC menu keeps both implementation choices understandable without descriptions", async () => {
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedRoast: { roast: ROAST, source: "roast_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi, MISSING_SETTINGS);
	let observedMenu: { title: string; options: string[] } | undefined;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/sessions/roasting.jsonl",
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
		select: async (title: string, options: string[]) => {
			observedMenu = { title, options };
			return undefined;
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("", context.ctx);
	assert.ok(observedMenu);
	assertImplementationChoiceCopy(observedMenu.title, observedMenu.options);
	assert.ok(observedMenu.options.includes("Show saved roast"));
});
