import assert from "node:assert/strict";
import { test } from "vitest";
import roastMode, { completeRoastArguments } from "../src/roast-mode.js";
import { restoreRoastModeState } from "../src/state.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

const ROAST = `# Saved implementation roast

1. Preserve the roast in this session.
2. Implement it later.`;
const STATE_ENTRY_TYPE = "roast-mode-state";
const MODEL = { provider: "test-provider", id: "test-model" };
const AVAILABLE_MODEL_REGISTRY = {
	getApiKeyAndHeaders: async () => ({ ok: true as const }),
};

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: STATE_ENTRY_TYPE, data };
}

function latestState(entries: readonly { data: unknown }[]) {
	return entries.at(-1)?.data as
		| {
				enabled?: boolean;
				latestRoast?: string;
				savedRoast?: { roast?: string; source?: string };
				activeImplementation?: { roast?: string };
		  }
		| undefined;
}

async function completeRoast(
	mock: ReturnType<typeof createMockPi>,
	ctx: ReturnType<typeof createMockContext>["ctx"],
) {
	const complete = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { roast: ROAST }, undefined, undefined, ctx);
}

test("saved Roast state restores from the active branch and rejects malformed values", () => {
	const savedRoast = { roast: ROAST, source: "roast_mode_complete" };
	const restored = restoreRoastModeState(
		[stateEntry({ enabled: false, awaitingAction: false, savedRoast })],
		STATE_ENTRY_TYPE,
	) as ReturnType<typeof restoreRoastModeState> & { savedRoast?: unknown };
	assert.deepEqual(restored.savedRoast, savedRoast);
	assert.equal(restored.enabled, false);
	assert.equal(restored.latestRoast, undefined);
	assert.equal(restored.activeImplementation, undefined);

	for (const invalidSavedRoast of [
		undefined,
		null,
		{},
		{ roast: " \n", source: "roast_mode_complete" },
		{ roast: "x".repeat(50_001), source: "roast_mode_complete" },
		{ roast: ROAST, source: "unknown" },
	]) {
		const invalid = restoreRoastModeState(
			[stateEntry({ enabled: false, awaitingAction: false, savedRoast: invalidSavedRoast })],
			STATE_ENTRY_TYPE,
		) as ReturnType<typeof restoreRoastModeState> & { savedRoast?: unknown };
		assert.equal(invalid.savedRoast, undefined);
	}

	const activeImplementation = {
		id: "implementation-1",
		roast: "# Active implementation",
		source: "roast_mode_complete",
		startedAt: 42,
	};
	const mixed = restoreRoastModeState(
		[
			stateEntry({
				enabled: false,
				awaitingAction: false,
				activeImplementation,
				savedRoast,
			}),
		],
		STATE_ENTRY_TYPE,
	) as ReturnType<typeof restoreRoastModeState> & { savedRoast?: unknown };
	assert.deepEqual(mixed.activeImplementation, { ...activeImplementation, retention: "keep" });
	assert.equal(mixed.savedRoast, undefined);
});

test("roast save exits Roast mode, restores runtime state, and keeps the roast out of context", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"], thinkingLevel: "low" });
	roastMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { thinkingLevel: "medium" as const },
		}),
	});
	const context = createMockContext({ hasUI: true });
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("start", context.ctx);
	assert.equal(mock.thinkingLevel, "medium");
	await completeRoast(mock, context.ctx);

	await mock.commands.get("roast")?.handler("save", context.ctx);

	assert.equal(context.statuses.get("roast-mode"), "roast saved");
	assert.match(JSON.stringify(context.widgets.get("roast-mode-roast")), /saved for later/i);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);
	assert.equal(mock.thinkingLevel, "low");
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /saved for later/i);
	assert.deepEqual(latestState(mock.entries)?.savedRoast, {
		roast: ROAST,
		source: "roast_mode_complete",
	});
	assert.equal(latestState(mock.entries)?.enabled, false);
	assert.equal(latestState(mock.entries)?.latestRoast, undefined);
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);

	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const transformed = (await contextHook(
		{
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "complete-1",
							name: "roast_mode_complete",
							arguments: { roast: ROAST },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "complete-1",
					toolName: "roast_mode_complete",
					content: [{ type: "text", text: ROAST }],
					details: { version: 1, source: "roast_mode_complete", roast: ROAST },
				},
				{ role: "custom", customType: "proposed-roast", content: ROAST },
				{ role: "user", content: "Unrelated work" },
			],
		},
		context.ctx,
	)) as { messages: unknown[] };
	assert.deepEqual(transformed.messages, [{ role: "user", content: "Unrelated work" }]);

	const entriesBeforeRepeat = mock.entries.length;
	await mock.commands.get("roast")?.handler("save", context.ctx);
	assert.equal(mock.entries.length, entriesBeforeRepeat);
	assert.equal(context.statuses.get("roast-mode"), "roast saved");
	assert.match(context.notifications.at(-1)?.message ?? "", /no completed roast/i);
});

test("automatic and manual ready menus expose Save for later", async () => {
	for (const automatic of [true, false]) {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		roastMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
		const context = createMockContext({
			hasUI: true,
			select: async (title: string, options: string[]) => {
				assert.match(title, /After Implement: Keep roast active until \/roast exit/i);
				assert.deepEqual(
					options.filter((option) => option !== "Close"),
					automatic
						? [
								"Implement here",
								"Start fresh and implement",
								"Export roast…",
								"Save for later",
								"Stay in Roast mode",
								"Discard roast and exit",
							]
						: [
								"Show latest proposed roast",
								"Implement here",
								"Start fresh and implement",
								"Export roast…",
								"Save for later",
								"Stay in Roast mode",
								"Discard roast and exit",
							],
				);
				return "Save for later";
			},
		});
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);
		if (automatic) await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		else await mock.commands.get("roast")?.handler("", context.ctx);

		assert.equal(context.statuses.get("roast-mode"), "roast saved");
		assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);
	}
});

test("saved Roast management can show, implement, clear, or cancel", async () => {
	for (const scenario of [
		{ mode: "tui", selection: "Show saved roast", expected: "saved" },
		{ mode: "rpc", selection: "Implement here", expected: "implementing" },
		{ mode: "tui", selection: "Clear saved roast", expected: "cleared" },
		{ mode: "tui", selection: undefined, expected: "saved" },
	] as const) {
		const savedEntry = stateEntry({
			enabled: false,
			awaitingAction: false,
			savedRoast: { roast: ROAST, source: "roast_mode_complete" },
		});
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		roastMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
		const context = createMockContext({
			mode: scenario.mode,
			model: MODEL,
			modelRegistry: AVAILABLE_MODEL_REGISTRY,
			sessionManager: {
				getBranch: () => [savedEntry],
				getEntries: () => [savedEntry],
			},
			select: async (title: string, options: string[]) => {
				assert.match(title, /After Implement: Keep roast active until \/roast exit/i);
				assert.deepEqual(
					options.filter((option) => option !== "Close"),
					[
						"Show saved roast",
						"Implement here",
						"Start fresh and implement",
						"Export roast…",
						"Settings",
						"Clear saved roast",
					],
				);
				return scenario.selection;
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const entriesBeforeMenu = mock.entries.length;
		await mock.commands.get("roast")?.handler("", context.ctx);

		if (scenario.expected === "saved") {
			assert.equal(context.statuses.get("roast-mode"), "roast saved");
			if (scenario.selection) {
				assert.match(
					String((mock.sentMessages.at(-1)?.message as { content?: string })?.content),
					/Saved Roast.*Saved implementation roast/is,
				);
			} else {
				assert.equal(mock.entries.length, entriesBeforeMenu);
			}
			await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
			assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);
		} else if (scenario.expected === "implementing") {
			assert.equal(context.statuses.get("roast-mode"), "roast implementing");
			assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /Saved implementation roast/);
			assert.equal(latestState(mock.entries)?.savedRoast, undefined);
			assert.equal(latestState(mock.entries)?.activeImplementation?.roast, ROAST);
		} else {
			assert.equal(context.statuses.get("roast-mode"), undefined);
			assert.equal(latestState(mock.entries)?.savedRoast, undefined);
		}
	}
});

test("failed ready implementation restores a manual Roast thinking level", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"], thinkingLevel: "low" });
	roastMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { thinkingLevel: "medium" as const },
		}),
	});
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("start", context.ctx);
	mock.rawPi.setThinkingLevel("high");
	await mock.events.get("thinking_level_select")?.[0]?.(
		{ level: "high", previousLevel: "medium" },
		context.ctx,
	);
	await completeRoast(mock, context.ctx);
	mock.rawPi.sendUserMessage = () => {
		throw new Error("ready handoff failed");
	};

	await mock.commands.get("roast")?.handler("implement", context.ctx);

	assert.equal(context.statuses.get("roast-mode"), "roast ready");
	assert.equal(mock.thinkingLevel, "high");
	assert.equal(latestState(mock.entries)?.latestRoast, ROAST);
	assert.match(context.notifications.at(-1)?.message ?? "", /ready handoff failed/);
});

test("saved Roast direct routes show, implement, roll back failures, and clear", async () => {
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedRoast: { roast: ROAST, source: "roast_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi);
	const context = createMockContext({
		isIdle: () => false,
		model: MODEL,
		modelRegistry: AVAILABLE_MODEL_REGISTRY,
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);

	await mock.commands.get("roast")?.handler("show", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(
		String((mock.sentMessages.at(-1)?.message as { content?: string })?.content),
		/Saved Roast.*Saved implementation roast/is,
	);

	mock.rawPi.sendUserMessage = () => {
		throw new Error("saved handoff failed");
	};
	await mock.commands.get("roast")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast saved");
	assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);
	assert.match(context.notifications.at(-1)?.message ?? "", /saved handoff failed/);

	mock.rawPi.sendUserMessage = (text: string, options?: unknown) => {
		mock.sentUserMessages.push({ text, options });
	};
	await mock.commands.get("roast")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast implementing");
	assert.deepEqual(mock.sentUserMessages.at(-1)?.options, { deliverAs: "followUp" });
	assert.equal(latestState(mock.entries)?.savedRoast, undefined);
	assert.equal(latestState(mock.entries)?.activeImplementation?.roast, ROAST);

	const clearMock = createMockPi({ activeTools: ["read"] });
	roastMode(clearMock.pi);
	const clearContext = createMockContext({
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await clearMock.events.get("session_start")?.[0]?.({}, clearContext.ctx);
	await clearMock.commands.get("roast")?.handler("exit", clearContext.ctx);
	assert.equal(clearContext.statuses.get("roast-mode"), undefined);
	assert.equal(latestState(clearMock.entries)?.savedRoast, undefined);
	assert.match(clearContext.notifications.at(-1)?.message ?? "", /saved roast cleared/i);
});

test("saved Roast implementation preflight retains state on auth failure or session replacement", async () => {
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedRoast: { roast: ROAST, source: "roast_mode_complete" },
	});
	const authFailure = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(authFailure.pi);
	const authFailureContext = createMockContext({
		hasUI: true,
		model: MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: false as const, error: "No test auth" }),
		},
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await authFailure.events.get("session_start")?.[0]?.({}, authFailureContext.ctx);
	await authFailure.commands.get("roast")?.handler("implement", authFailureContext.ctx);
	assert.equal(authFailureContext.statuses.get("roast-mode"), "roast saved");
	assert.equal(authFailure.sentUserMessages.length, 0);
	assert.match(authFailureContext.notifications.at(-1)?.message ?? "", /No test auth/);

	let resolveAuth!: (result: { ok: true }) => void;
	const authPending = new Promise<{ ok: true }>((resolve) => {
		resolveAuth = resolve;
	});
	const replaced = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(replaced.pi);
	const replacedContext = createMockContext({
		hasUI: true,
		model: MODEL,
		modelRegistry: { getApiKeyAndHeaders: () => authPending },
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await replaced.events.get("session_start")?.[0]?.({}, replacedContext.ctx);
	const pendingImplementation = replaced.commands
		.get("roast")
		?.handler("implement", replacedContext.ctx);
	await replaced.events.get("session_shutdown")?.[0]?.({}, replacedContext.ctx);
	resolveAuth({ ok: true });
	await pendingImplementation;
	assert.equal(replaced.sentUserMessages.length, 0);
	assert.equal(latestState(replaced.entries)?.savedRoast?.roast, ROAST);
});

test("saved Roast blocks replacement workflows and --roast restores it as ready", async () => {
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedRoast: { roast: ROAST, source: "roast_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.commands.get("roast")?.handler("design something else", context.ctx);
	await mock.commands.get("roast")?.handler("tools", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);
	assert.equal(context.statuses.get("roast-mode"), "roast saved");
	assert.match(context.notifications.at(-1)?.message ?? "", /implement or clear/i);
	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);

	const flagged = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(flagged.pi);
	const flag = flagged.flags.get("roast");
	assert.ok(flag);
	flag.value = true;
	const flaggedContext = createMockContext({
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await flagged.events.get("session_start")?.[0]?.({}, flaggedContext.ctx);
	assert.equal(flaggedContext.statuses.get("roast-mode"), "roast ready");
	assert.equal(latestState(flagged.entries)?.latestRoast, ROAST);
	assert.equal(latestState(flagged.entries)?.savedRoast, undefined);
	assert.deepEqual(flagged.rawPi.getActiveTools(), [
		"read",
		"roast_mode_question",
		"roast_mode_complete",
	]);
});

test("saved Roast no-UI management is observable without changing state", async () => {
	for (const mode of ["print", "json"] as const) {
		const savedEntry = stateEntry({
			enabled: false,
			awaitingAction: false,
			savedRoast: { roast: ROAST, source: "roast_mode_complete" },
		});
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		roastMode(mock.pi);
		const context = createMockContext({
			mode,
			hasUI: false,
			sessionManager: {
				getBranch: () => [savedEntry],
				getEntries: () => [savedEntry],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await assert.rejects(
			mock.commands.get("roast")?.handler("", context.ctx) as Promise<unknown>,
			/\/roast start.*\/roast <prompt>/i,
		);
		await assert.rejects(
			mock.commands.get("roast")?.handler("design something else", context.ctx) as Promise<unknown>,
			/implement or clear/i,
		);
		await assert.rejects(
			mock.commands.get("roast")?.handler("tools", context.ctx) as Promise<unknown>,
			/implement or clear/i,
		);
		await assert.rejects(
			mock.commands.get("roast")?.handler("show", context.ctx) as Promise<unknown>,
			/saved roast.*print|print.*saved roast/i,
		);
		await assert.rejects(
			mock.commands.get("roast")?.handler("implement", context.ctx) as Promise<unknown>,
			/saved roast.*print|print.*saved roast/i,
		);
		assert.equal(context.statuses.get("roast-mode"), "roast saved");
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);
	}
});

test("print and JSON modes can save and clear a ready roast", async () => {
	for (const mode of ["print", "json"] as const) {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		roastMode(mock.pi);
		const context = createMockContext({ mode, hasUI: false });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);

		await mock.commands.get("roast")?.handler("save", context.ctx);
		assert.equal(context.statuses.get("roast-mode"), "roast saved");
		assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);

		await assert.rejects(
			mock.commands.get("roast")?.handler("show", context.ctx) as Promise<unknown>,
			/saved roast.*print|print.*saved roast/i,
		);
		await assert.rejects(
			mock.commands.get("roast")?.handler("implement", context.ctx) as Promise<unknown>,
			/saved roast.*print|print.*saved roast/i,
		);
		assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);
		assert.equal(mock.sentUserMessages.length, 0);

		await mock.commands.get("roast")?.handler(mode === "json" ? "off" : "exit", context.ctx);
		assert.equal(context.statuses.get("roast-mode"), undefined);
		assert.equal(latestState(mock.entries)?.savedRoast, undefined);
	}
});

test("session shutdown disposes a saved Roast menu without a late transition", async () => {
	let menuHarness: ReturnType<typeof createCustomSelectorHarness> | undefined;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedRoast: { roast: ROAST, source: "roast_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	roastMode(mock.pi);
	const context = createMockContext({
		mode: "tui",
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
		custom: async (factory: unknown) => {
			menuHarness = createCustomSelectorHarness(factory);
			markStarted();
			return menuHarness.resultPromise;
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const pendingMenu = mock.commands.get("roast")?.handler("", context.ctx);
	await started;
	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	await pendingMenu;

	assert.ok(menuHarness);
	assert.equal(context.statuses.get("roast-mode"), undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);
	assert.equal(latestState(mock.entries)?.savedRoast?.roast, ROAST);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("roast save autocomplete is public and saving fails closed without a ready roast", async () => {
	assert.deepEqual(
		completeRoastArguments("")?.map((item) => item.value),
		["start", "show", "finalize", "implement", "save", "export", "exit", "off", "tools"],
	);
	assert.deepEqual(
		completeRoastArguments("sa")?.map((item) => item.value),
		["save"],
	);
	assert.equal(completeRoastArguments("save "), null);

	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("roast")?.handler("save", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), undefined);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(latestState(mock.entries)?.savedRoast, undefined);
	assert.match(context.notifications.at(-1)?.message ?? "", /no completed roast/i);

	const printMock = createMockPi({ activeTools: ["read"] });
	roastMode(printMock.pi);
	const printContext = createMockContext({ mode: "print", hasUI: false });
	await assert.rejects(
		printMock.commands.get("roast")?.handler("save", printContext.ctx) as Promise<unknown>,
		/no completed roast/i,
	);
});
