import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { roastModeCompleted } from "../src/completion-tool.js";
import roastMode, {
	buildRoastModePrompt,
	completeRoastArguments,
	extractProposedRoast,
	latestAssistantText,
	parseProposedRoast,
	stripProposedRoastBlocks,
	stripProposedRoastBlocksFromMessage,
} from "../src/roast-mode.js";
import { createMockContext, createMockPi } from "./support.js";

test("roast-mode registers flag, question tool, command, and safety hooks", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	roastMode(mock.pi);

	assert.ok(mock.flags.has("roast"));
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["roast_mode_question", "roast_mode_complete"],
	);
	assert.ok(mock.commands.has("roast"));
	assert.equal(typeof mock.commands.get("roast")?.getArgumentCompletions, "function");
	assert.ok(mock.events.has("tool_call"));
	assert.ok(mock.events.has("before_agent_start"));
});

test("non-interactive Roast routes do not load interactive UI", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	let interactiveLoads = 0;
	roastMode(mock.pi, {
		readSettings: async () => ({ kind: "missing" as const }),
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return import("../src/interactive-ui.js");
		},
	});
	const context = createMockContext({ mode: "tui" });
	const sessionStart = mock.events.get("session_start")?.[0];
	assert.ok(sessionStart);
	await sessionStart({}, context.ctx);
	assert.equal(interactiveLoads, 0);

	const roastCommand = mock.commands.get("roast");
	assert.ok(roastCommand);
	await roastCommand.handler("start", context.ctx);
	assert.equal(interactiveLoads, 0);
	await roastCommand.handler("write a release roast", context.ctx);
	assert.equal(interactiveLoads, 0);
});

test("stale Roast settings callbacks do not reload interactive UI", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	let interactiveLoads = 0;
	let showSettings: ((signal: AbortSignal) => Promise<boolean>) | undefined;
	roastMode(mock.pi, {
		readSettings: async () => ({ kind: "missing" as const }),
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return {
				showRoastLaunchMenu: async (_ctx: unknown, options: unknown) => {
					showSettings = (options as { settings(signal: AbortSignal): Promise<boolean> }).settings;
				},
			} as never;
		},
	});
	const context = createMockContext({ mode: "tui" });
	const roastCommand = mock.commands.get("roast");
	assert.ok(roastCommand);
	await roastCommand.handler("", context.ctx);
	assert.equal(interactiveLoads, 1);
	assert.ok(showSettings);

	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionShutdown);
	await sessionShutdown({}, context.ctx);
	await showSettings(new AbortController().signal);

	assert.equal(interactiveLoads, 1);
});

test("roast_mode_complete result renders the roast as Markdown", () => {
	initTheme("dark");
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	roastMode(mock.pi);
	const tool = mock.tools.find((candidate) => candidate.name === "roast_mode_complete");
	assert.equal(typeof tool?.renderResult, "function");

	const renderResult = tool?.renderResult as (
		result: unknown,
		options: unknown,
	) => { render(width: number): string[] };
	const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	const renderMarkdown = (result: unknown) =>
		renderResult(result, { expanded: false, isPartial: false })
			.render(80)
			.map((line) => line.replace(ansiPattern, ""))
			.join("\n");

	const result = roastModeCompleted("# Title\n\n- item\n\n```ts\nconst x = 1;\n```");
	const rendered = renderMarkdown(result);
	assert.match(rendered, /Proposed Roast/);
	assert.match(rendered, /const x = 1;/);
	assert.doesNotMatch(rendered, /\*\*Proposed Roast\*\*/);
	assert.doesNotMatch(rendered, /# Title/);

	const fallback = renderMarkdown({ content: [], details: result.details });
	assert.match(fallback, /Proposed Roast/);
	assert.match(fallback, /const x = 1;/);
});

test("completeRoastArguments suggests management tokens only", () => {
	assert.deepEqual(
		completeRoastArguments("")?.map((item) => item.label),
		["start", "show", "finalize", "implement", "save", "export", "exit", "off", "tools"],
	);
	assert.deepEqual(
		completeRoastArguments("to")?.map((item) => item.value),
		["tools"],
	);
	assert.equal(completeRoastArguments("tools "), null);
	assert.equal(completeRoastArguments("write a roast"), null);
	assert.equal(completeRoastArguments("unknown"), null);
});

test("missing settings reset a previously loaded fixed thinking level", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-settings-reset-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = join(directory, "pi-roast-mode.json");
		await writeFile(settingsPath, '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
		roastMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await unlink(settingsPath);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.equal(mock.thinkingLevel, "low");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("malformed persisted Roast state fails closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-malformed-state-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		roastMode(mock.pi);
		const malformedState = {
			type: "custom",
			customType: "roast-mode-state",
			data: {
				enabled: "yes",
				awaitingAction: 1,
				selectedToolNames: "read",
				previousThinkingLevel: "extreme",
			},
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [malformedState],
				getEntries: () => [malformedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("roast-mode"), undefined);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("inherit settings clear stale persisted thinking ownership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-inherit-ownership-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "medium" });
		roastMode(mock.pi);
		const inheritedState = {
			type: "custom",
			customType: "roast-mode-state",
			data: {
				enabled: true,
				awaitingAction: false,
				previousThinkingLevel: "low",
				appliedThinkingLevel: "medium",
			},
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [inheritedState],
				getEntries: () => [inheritedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("session resume restores active Roast state and required tools", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		roastMode(mock.pi);
		const resumedState = {
			type: "custom",
			customType: "roast-mode-state",
			data: { enabled: true, awaitingAction: true, latestRoast: "# Resumed" },
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [resumedState],
				getEntries: () => [resumedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("roast-mode"), "roast ready");
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"roast_mode_question",
			"roast_mode_complete",
		]);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("session restore uses only the active branch state", async () => {
	const activeBranch = [
		{
			type: "custom",
			customType: "roast-mode-state",
			data: {
				enabled: true,
				awaitingAction: true,
				latestRoast: "# Active branch",
				latestRoastSource: "roast_mode_complete",
			},
		},
	];
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getBranch: () => activeBranch,
			getEntries: () => [
				...activeBranch,
				{
					type: "custom",
					customType: "roast-mode-state",
					data: { enabled: false, awaitingAction: false },
				},
			],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("roast")?.handler("show", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast ready");
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Active branch/,
	);
});

test("session restore fails closed for malformed persisted completed roasts", async () => {
	for (const data of [
		{
			enabled: true,
			awaitingAction: true,
			latestRoast: "  \n",
			latestRoastSource: "roast_mode_complete",
		},
		{
			enabled: true,
			awaitingAction: true,
			latestRoast: "x".repeat(50_001),
			latestRoastSource: "roast_mode_complete",
		},
	]) {
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		const context = createMockContext({
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [{ type: "custom", customType: "roast-mode-state", data }],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("roast-mode"), "roast active");
		await mock.commands.get("roast")?.handler("implement", context.ctx);
		assert.equal(mock.sentUserMessages.length, 0);
	}

	const legacy = createMockPi({ activeTools: ["read"] });
	roastMode(legacy.pi);
	const legacyContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "roast-mode-state",
					data: {
						enabled: true,
						awaitingAction: true,
						latestRoast: "# Legacy state",
					},
				},
			],
		},
	});
	await legacy.events.get("session_start")?.[0]?.({}, legacyContext.ctx);
	assert.equal(legacyContext.statuses.get("roast-mode"), "roast ready");
});

test("session restore recovers only valid completion details after the latest state", async () => {
	const completion = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "roast_mode_complete",
			details: {
				version: 1,
				source: "roast_mode_complete",
				roast: "# Recovered",
			},
		},
	};
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "roast-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
				completion,
			],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast ready");
	await mock.commands.get("roast")?.handler("show", context.ctx);
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Recovered/,
	);

	const discarded = createMockPi({ activeTools: ["read"] });
	roastMode(discarded.pi);
	const discardedContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				completion,
				{
					type: "custom",
					customType: "roast-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
			],
		},
	});
	await discarded.events.get("session_start")?.[0]?.({}, discardedContext.ctx);
	assert.equal(discardedContext.statuses.get("roast-mode"), "roast active");

	const malformed = createMockPi({ activeTools: ["read"] });
	roastMode(malformed.pi);
	const malformedContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "roast-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
				{
					...completion,
					message: {
						...completion.message,
						details: { version: 2, source: "roast_mode_complete", roast: "# Bad" },
					},
				},
			],
		},
	});
	await malformed.events.get("session_start")?.[0]?.({}, malformedContext.ctx);
	assert.equal(malformedContext.statuses.get("roast-mode"), "roast active");
});

test("Roast thinking level restores only while the extension owns the applied value", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "pi-roast-mode.json"), '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read", "bash"], thinkingLevel: "low" });
		roastMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
		await mock.commands.get("roast")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "low");

		await mock.commands.get("roast")?.handler("start", context.ctx);
		mock.rawPi.setThinkingLevel("high");
		await mock.commands.get("roast")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "high");

		const clamped = createMockPi({
			activeTools: ["read"],
			thinkingLevel: "high",
			clampThinkingLevel: (level) => (level === "medium" ? "low" : level),
		});
		roastMode(clamped.pi);
		const clampedContext = createMockContext();
		await clamped.events.get("session_start")?.[0]?.({}, clampedContext.ctx);
		await clamped.commands.get("roast")?.handler("start", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "low");
		await clamped.commands.get("roast")?.handler("exit", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "high");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast mode restores an intentionally empty active-tool set", async () => {
	const mock = createMockPi({ activeTools: [], allTools: [] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"roast_mode_question",
		"roast_mode_complete",
	]);
	await mock.commands.get("roast")?.handler("exit", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), []);
});

test("manual thinking changes survive active Roast-mode shutdown and resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-manual-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "pi-roast-mode.json"), '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
		roastMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		mock.rawPi.setThinkingLevel("high");
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);

		const persisted = mock.entries.at(-1);
		const persistedEntries = persisted ? [{ type: "custom", ...persisted }] : [];
		const resumedContext = createMockContext({
			sessionManager: {
				getBranch: () => persistedEntries,
				getEntries: () => persistedEntries,
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, resumedContext.ctx);
		assert.equal(mock.thinkingLevel, "high");
		await mock.commands.get("roast")?.handler("exit", resumedContext.ctx);
		assert.equal(mock.thinkingLevel, "high");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast lifecycle enters with a prompt and hands a valid roast to implementation", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => "Implement here",
	});
	await mock.commands.get("roast")?.handler("design it", context.ctx);
	assert.deepEqual(mock.sentUserMessages[0], { text: "design it", options: undefined });
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"roast_mode_question",
		"roast_mode_complete",
	]);

	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [{ role: "assistant", content: "<proposed_roast>\n# Ship it\n</proposed_roast>" }],
		},
		context.ctx,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"roast_mode_question",
		"roast_mode_complete",
	]);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "custom"]);
	assert.match(
		mock.sentUserMessages.at(-1)?.text ?? "",
		/Implement this proposed roast now:\n\n# Ship it/,
	);
	assert.equal(context.statuses.get("roast-mode"), "roast implementing");
});

test("roast show displays only a stored roast without triggering a model turn", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.commands.get("roast")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /No completed roast/i);

	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { roast: "# Show me" }, undefined, undefined, context.ctx);
	await mock.commands.get("roast")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 1);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match((mock.sentMessages[0]?.message as { content?: string })?.content ?? "", /# Show me/);
});

test("roast show keeps a completed roast ready when display delivery fails", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { roast: "# Still ready" }, undefined, undefined, context.ctx);
	mock.rawPi.sendMessage = () => {
		throw new Error("display unavailable");
	};

	await assert.doesNotReject(async () => {
		await mock.commands.get("roast")?.handler("show", context.ctx);
	});
	assert.equal(context.statuses.get("roast-mode"), "roast ready");
	assert.match(context.notifications.at(-1)?.message ?? "", /display unavailable/);
});

test("roast finalize requires active mode and uses idle-safe delivery", async () => {
	let idle = true;
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({ isIdle: () => idle });
	await mock.commands.get("roast")?.handler("finalize", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /not active/i);

	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.commands.get("roast")?.handler("finalize", context.ctx);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /roast_mode_complete/);
	assert.equal(mock.sentUserMessages.at(-1)?.options, undefined);

	idle = false;
	await mock.commands.get("roast")?.handler("finalize", context.ctx);
	assert.deepEqual(mock.sentUserMessages.at(-1)?.options, { deliverAs: "followUp" });
});

test("/roast start is a no-op while an active Roast workflow is already ready", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("ready", { roast: "# Ready" }, undefined, undefined, context.ctx);
	const entriesBeforeStart = mock.entries.length;

	await mock.commands.get("roast")?.handler("start", context.ctx);

	assert.equal(context.statuses.get("roast-mode"), "roast ready");
	assert.equal(mock.entries.length, entriesBeforeStart);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /already active/i);
});

test("roast implement fails closed without a roast and hands off a stored roast", async () => {
	const mock = createMockPi({ activeTools: ["read", "custom"] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.commands.get("roast")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast active");
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /No completed roast/i);

	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { roast: "# Implement me" }, undefined, undefined, context.ctx);
	await mock.commands.get("roast")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast implementing");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "custom"]);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Implement me/);
});

test("failed finalize delivery keeps Roast mode active", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.commands.get("roast")?.handler("finalize", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast active");
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
});

test("inline prompt delivery failure rolls back newly entered Roast mode", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("design it", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
});

test("invalid proposed roasts remain unready and notify the user", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_roast>unfinished" }] },
		context.ctx,
	);
	assert.match(context.notifications.at(-1)?.message ?? "", /closing tag is missing/);
	assert.equal(context.statuses.get("roast-mode"), "roast active");
});

test("prose-only promise to present a roast remains active without false readiness", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);

	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: "Now I have a complete understanding. Let me present the roast.",
				},
			],
		},
		context.ctx,
	);

	assert.equal(context.statuses.get("roast-mode"), "roast active");
	assert.equal(mock.sentMessages.length, 0);
});

test("roast_mode_complete stores a visible terminating roast contract", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	roastMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("roast")?.handler("start", context.ctx);

	const tool = mock.tools.find((candidate) => candidate.name === "roast_mode_complete");
	assert.ok(tool);
	const execute = tool.execute as
		| ((...args: unknown[]) => Promise<{
				content: Array<{ type: string; text: string }>;
				details?: { version?: number; roast?: string; source?: string };
				terminate?: boolean;
		  }>)
		| undefined;
	assert.ok(execute);

	const result = await execute(
		"call-complete",
		{ roast: "# Ship it\n\n## Test Roast\n\n- Run checks." },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(result.terminate, true);
	assert.match(result.content[0]?.text ?? "", /# Ship it/);
	assert.deepEqual(result.details, {
		version: 1,
		source: "roast_mode_complete",
		roast: "# Ship it\n\n## Test Roast\n\n- Run checks.",
	});
	assert.equal(context.statuses.get("roast-mode"), "roast ready");
});

test("roast completion dispatches the ready menu once after agent_settled", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Roast mode";
		},
	});
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await execute("complete", { roast: "# Ready" }, undefined, undefined, context.ctx);
	assert.equal(selectCalls, 0);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(context.statuses.get("roast-mode"), "roast ready");
});

test("legacy roast completion is presented once only after settlement", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Roast mode";
		},
	});
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_roast>\n# Legacy\n</proposed_roast>" }] },
		context.ctx,
	);
	assert.equal(selectCalls, 0);
	assert.equal(mock.sentMessages.length, 0);

	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 1);
	assert.match((mock.sentMessages[0]?.message as { content?: string })?.content ?? "", /# Legacy/);
});

test("linus mode requires roast_mode_question before roast_mode_complete", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-linus-gate-"));
	const settingsPath = join(directory, "pi-roast-mode.json");
	try {
		await writeFile(settingsPath, '{"roastStyle":"linus"}');
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi, { settingsPath });
		const context = createMockContext({
			hasUI: true,
			select: async (_title: string, options: string[]) => options[0] ?? undefined,
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);

		const complete = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
			?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
		assert.ok(complete);
		await assert.rejects(
			complete("complete", { roast: "# No questions" }, undefined, undefined, context.ctx),
			/Linus mode requires roast_mode_question/,
		);
		assert.equal(context.statuses.get("roast-mode"), "roast active");

		const question = mock.tools.find((candidate) => candidate.name === "roast_mode_question")
			?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
		assert.ok(question);
		await question(
			"ask",
			{
				questions: [
					{
						id: "fix",
						header: "Fix",
						question: "Should the fix drop the legacy API?",
						options: [
							{ label: "Yes", description: "Drop it." },
							{ label: "No", description: "Keep it." },
						],
					},
				],
			},
			undefined,
			undefined,
			context.ctx,
		);
		await complete("complete", { roast: "# With questions" }, undefined, undefined, context.ctx);
		assert.equal(context.statuses.get("roast-mode"), "roast ready");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("linus mode blocks the legacy proposed-roast path without questions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-linus-legacy-"));
	const settingsPath = join(directory, "pi-roast-mode.json");
	try {
		await writeFile(settingsPath, '{"roastStyle":"linus"}');
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi, { settingsPath });
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);

		await mock.events.get("agent_end")?.[0]?.(
			{
				messages: [{ role: "assistant", content: "<proposed_roast>\n# Legacy\n</proposed_roast>" }],
			},
			context.ctx,
		);
		assert.equal(context.statuses.get("roast-mode"), "roast active");
		assert.match(context.notifications.at(-1)?.message ?? "", /requires roast_mode_question/);
		assert.equal(mock.sentMessages.length, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("settled roast presentation waits for idle without pending messages", async () => {
	let idle = false;
	let pending = false;
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		select: async () => {
			selectCalls += 1;
			return "Stay in Roast mode";
		},
	});
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { roast: "# Wait" }, undefined, undefined, context.ctx);

	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	idle = true;
	pending = true;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 0);
	pending = false;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
});

test("duplicate and replacement completions present only the latest roast once", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Roast mode";
		},
	});
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await execute("first", { roast: "# First" }, undefined, undefined, context.ctx);
	await execute("duplicate", { roast: "# First" }, undefined, undefined, context.ctx);
	await execute("replacement", { roast: "# Replacement" }, undefined, undefined, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(
		(mock.entries.at(-1)?.data as { latestRoast?: string })?.latestRoast,
		"# Replacement",
	);
});

test("repeated legacy agent_end events produce one settled presentation", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Roast mode";
		},
	});
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const event = {
		messages: [{ role: "assistant", content: "<proposed_roast>\n# Retry\n</proposed_roast>" }],
	};
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 1);
});

test("no-UI completion remains ready without opening or duplicating presentation", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { roast: "# Headless" }, undefined, undefined, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast ready");
	assert.equal(mock.sentMessages.length, 0);
});

test("stale settled legacy presentation is ignored without losing ready state", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.sendMessage = () => {
		throw new Error("This extension ctx is stale after session replacement or reload");
	};
	roastMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{ role: "assistant", content: "<proposed_roast>\n# Persisted\n</proposed_roast>" },
			],
		},
		context.ctx,
	);
	await assert.doesNotReject(async () => {
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	});
	assert.equal(context.statuses.get("roast-mode"), "roast ready");
});

test("a newer Roast turn cancels stale ready presentation", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Roast mode";
		},
	});
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { roast: "# Stale" }, undefined, undefined, context.ctx);
	await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 0);
	assert.equal(context.statuses.get("roast-mode"), "roast active");
});

test("roast_mode_complete rejects inactive and invalid submissions", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext();
	const execute = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await assert.rejects(
		execute("inactive", { roast: "# Roast" }, undefined, undefined, context.ctx),
		/only available while Roast mode is active/,
	);
	await mock.commands.get("roast")?.handler("start", context.ctx);
	await assert.rejects(
		execute("empty", { roast: "  \n" }, undefined, undefined, context.ctx),
		/must not be empty/,
	);
	await assert.rejects(
		execute("large", { roast: "x".repeat(50_001) }, undefined, undefined, context.ctx),
		/must not exceed 50000 characters/,
	);
	assert.equal(context.statuses.get("roast-mode"), "roast active");
});

test("proposed-roast parser distinguishes valid and malformed output", () => {
	assert.deepEqual(parseProposedRoast("No roast"), { kind: "absent" });
	assert.deepEqual(parseProposedRoast("<proposed_roast>\n# Roast\n</proposed_roast>"), {
		kind: "valid",
		roast: "# Roast",
	});
	assert.equal(parseProposedRoast("<proposed_roast>\n\n</proposed_roast>").kind, "empty");
	assert.equal(
		parseProposedRoast("<proposed_roast>a</proposed_roast><proposed_roast>b</proposed_roast>").kind,
		"multiple",
	);
	assert.equal(parseProposedRoast("before <proposed_roast>bad</proposed_roast>").kind, "malformed");
	assert.equal(parseProposedRoast("<proposed_roast>unfinished").kind, "unclosed");
	assert.equal(
		parseProposedRoast("<PROPOSED_ROAST>\n# Roast\n</PROPOSED_ROAST>").kind,
		"malformed",
	);
});

test("active Roast UI advertises the completion tool rather than legacy XML", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	let activeMenu = "";
	const context = createMockContext({
		hasUI: true,
		select: async (title: string) => {
			activeMenu = title;
			return undefined;
		},
	});
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const widget = context.widgets.get("roast-mode-roast") as string[];
	assert.match(widget.join("\n"), /roast_mode_complete/);
	assert.doesNotMatch(widget.join("\n"), /proposed_roast/);
	await mock.commands.get("roast")?.handler("", context.ctx);
	assert.match(activeMenu, /roast_mode_complete/);
	assert.doesNotMatch(activeMenu, /proposed_roast/);
});

test("inactive context discards completed-roast tool results", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	roastMode(mock.pi);
	const context = createMockContext();
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const assistantWithCalls = {
		role: "assistant",
		content: [
			{ type: "text", text: "keep explanation" },
			{ type: "toolCall", id: "roast-call", name: "roast_mode_complete", arguments: {} },
			{ type: "toolCall", id: "read-call", name: "read", arguments: {} },
		],
	};
	const assistantWithOnlyCompletion = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "only-roast-call", name: "roast_mode_complete", arguments: {} },
		],
	};
	const completionResult = {
		role: "toolResult",
		toolCallId: "roast-call",
		toolName: "roast_mode_complete",
		content: [{ type: "text", text: "**Proposed Roast**\n\n# Discarded" }],
		details: { version: 1, source: "roast_mode_complete", roast: "# Discarded" },
	};
	const unrelatedResult = {
		role: "toolResult",
		toolCallId: "read-call",
		toolName: "read",
		content: [{ type: "text", text: "keep me" }],
	};
	const allMessages = [
		assistantWithCalls,
		assistantWithOnlyCompletion,
		completionResult,
		unrelatedResult,
	];

	const inactive = (await contextHook({ messages: allMessages }, context.ctx)) as {
		messages: unknown[];
	};
	assert.deepEqual(inactive.messages, [
		{
			...assistantWithCalls,
			content: [assistantWithCalls.content[0], assistantWithCalls.content[2]],
		},
		unrelatedResult,
	]);

	await mock.commands.get("roast")?.handler("start", context.ctx);
	const active = (await contextHook({ messages: allMessages }, context.ctx)) as {
		messages: unknown[];
	};
	assert.deepEqual(active.messages, allMessages);
});

test("Roast prompt requires the standalone completion contract", () => {
	const prompt = buildRoastModePrompt();
	assert.match(prompt, /Roast persona: Mid/);
	assert.match(prompt, /recommended option.*assumption/i);
	assert.match(prompt, /roast_mode_complete/i);
	assert.match(prompt, /alone as (?:your )?(?:final|last) action/i);
	assert.match(prompt, /end.*roast_mode_question.*roast_mode_complete/is);
	assert.match(prompt, /clarification.*roast_mode_complete.*unchanged/is);
	assert.match(prompt, /behavior-level/i);
	assert.doesNotMatch(prompt, /<proposed_roast>/i);
});

test("Roast prompt selects the persona block by style", () => {
	assert.match(buildRoastModePrompt("soft"), /Roast persona: Soft/);
	assert.doesNotMatch(buildRoastModePrompt("soft"), /Roast persona: Linus/);
	assert.match(buildRoastModePrompt("hard"), /Roast persona: Hard/);
	assert.match(buildRoastModePrompt("linus"), /choice of programming language/);
	assert.equal(buildRoastModePrompt("linus"), buildRoastModePrompt("linus"));
});

test("proposed-roast helpers extract and remove roast blocks", () => {
	assert.equal(
		extractProposedRoast("Intro\n<proposed_roast>\n# Roast\n</proposed_roast>"),
		"# Roast",
	);
	assert.equal(
		stripProposedRoastBlocks("A\n<proposed_roast>\nsecret\n</proposed_roast>\nB"),
		"A\n\nB",
	);
	assert.equal(
		stripProposedRoastBlocks("A<proposed_roast>malformed</proposed_roast>B"),
		"A<proposed_roast>malformed</proposed_roast>B",
	);
	assert.deepEqual(
		stripProposedRoastBlocksFromMessage({
			role: "assistant",
			content: [{ type: "text", text: "Keep\n<proposed_roast>\nremove\n</proposed_roast>" }],
		}),
		{ role: "assistant", content: [{ type: "text", text: "Keep\n" }] },
	);
	assert.equal(
		latestAssistantText([
			{ role: "user", content: "ignore" },
			{ message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		]),
		"answer",
	);
});
