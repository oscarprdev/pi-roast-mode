import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import roastMode from "../src/roast-mode.js";
import {
	builtinTool,
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
	extensionTool,
} from "./support.js";

const REQUIRED_ROAST_TOOLS = ["roast_mode_question", "roast_mode_complete"];

test("fresh Roast mode uses configured default tools and restores previous tools", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({
				defaultRoastTools: ["bash", "custom", "write", "missing", "bash"],
			}),
		);
		const mock = createMockPi({
			activeTools: ["read", "write"],
			allTools: [
				builtinTool("read"),
				builtinTool("bash"),
				builtinTool("write"),
				extensionTool("custom"),
			],
		});
		roastMode(mock.pi);
		const context = createMockContext();

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", "custom", ...REQUIRED_ROAST_TOOLS]);
		const hook = mock.events.get("tool_call")?.[0];
		assert.equal(
			await hook?.({ toolName: "custom", input: { arbitrary: { nested: true } } }, context.ctx),
			undefined,
		);

		await mock.commands.get("roast")?.handler("exit", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	});
});

test("missing and empty default tool settings remain distinct", async () => {
	await withAgentDir(async (agentDir) => {
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("grep"),
			builtinTool("write"),
			extensionTool("custom"),
		];
		const missing = createMockPi({ activeTools: ["write"], allTools });
		roastMode(missing.pi);
		const missingContext = createMockContext();
		await missing.events.get("session_start")?.[0]?.({}, missingContext.ctx);
		await missing.commands.get("roast")?.handler("start", missingContext.ctx);
		assert.deepEqual(missing.rawPi.getActiveTools(), [
			"bash",
			"grep",
			"read",
			...REQUIRED_ROAST_TOOLS,
		]);

		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({ defaultRoastTools: [] }),
		);
		const empty = createMockPi({ activeTools: ["write"], allTools });
		roastMode(empty.pi);
		const emptyContext = createMockContext();
		await empty.events.get("session_start")?.[0]?.({}, emptyContext.ctx);
		await empty.commands.get("roast")?.handler("start", emptyContext.ctx);
		assert.deepEqual(empty.rawPi.getActiveTools(), REQUIRED_ROAST_TOOLS);
	});
});

test("explicit defaults stay fail closed when tool metadata is unavailable", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, "pi-roast-mode.json");
		await writeFile(settingsPath, JSON.stringify({ defaultRoastTools: [] }));
		const explicit = createMockPi({ activeTools: ["write"], allTools: [] });
		roastMode(explicit.pi);
		const explicitContext = createMockContext();
		await explicit.events.get("session_start")?.[0]?.({}, explicitContext.ctx);
		await explicit.commands.get("roast")?.handler("start", explicitContext.ctx);
		assert.deepEqual(explicit.rawPi.getActiveTools(), REQUIRED_ROAST_TOOLS);

		await rm(settingsPath);
		const fallback = createMockPi({ activeTools: ["write"], allTools: [] });
		roastMode(fallback.pi);
		const fallbackContext = createMockContext();
		await fallback.events.get("session_start")?.[0]?.({}, fallbackContext.ctx);
		await fallback.commands.get("roast")?.handler("start", fallbackContext.ctx);
		assert.deepEqual(fallback.rawPi.getActiveTools(), ["read", "bash", ...REQUIRED_ROAST_TOOLS]);
	});
});

test("restored session tool selections override configured defaults", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({ defaultRoastTools: ["bash", "custom"] }),
		);
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("grep"),
			extensionTool("custom"),
		];

		for (const { data, expected } of [
			{
				data: { enabled: true, awaitingAction: false, selectedToolNames: ["read"] },
				expected: ["read", ...REQUIRED_ROAST_TOOLS],
			},
			{
				data: { enabled: true, awaitingAction: false, selectedToolNames: [] },
				expected: REQUIRED_ROAST_TOOLS,
			},
			{
				data: {
					enabled: true,
					awaitingAction: false,
					selectedToolKeys: ["grep\u001fbuiltin"],
				},
				expected: ["grep", ...REQUIRED_ROAST_TOOLS],
			},
		]) {
			const mock = createMockPi({ activeTools: ["write"], allTools });
			roastMode(mock.pi);
			const stateEntry = { type: "custom", customType: "roast-mode-state", data };
			const context = createMockContext({
				sessionManager: {
					getBranch: () => [stateEntry],
					getEntries: () => [stateEntry],
				},
			});

			await mock.events.get("session_start")?.[0]?.({}, context.ctx);
			assert.deepEqual(mock.rawPi.getActiveTools(), expected);
		}
	});
});

test("settings reload resets removed or invalid configured defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, "pi-roast-mode.json");
		await writeFile(settingsPath, JSON.stringify({ defaultRoastTools: ["bash"] }));
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("grep"),
			builtinTool("write"),
		];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		roastMode(mock.pi);
		const context = createMockContext();

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", ...REQUIRED_ROAST_TOOLS]);
		await mock.commands.get("roast")?.handler("exit", context.ctx);

		await rm(settingsPath);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"bash",
			"grep",
			"read",
			...REQUIRED_ROAST_TOOLS,
		]);
		await mock.commands.get("roast")?.handler("exit", context.ctx);

		await writeFile(settingsPath, JSON.stringify({ defaultRoastTools: "read" }));
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"bash",
			"grep",
			"read",
			...REQUIRED_ROAST_TOOLS,
		]);
		assert.match(context.notifications.at(-2)?.message ?? "", /settings ignored/i);
	});
});

test("configured names follow effective sources without dynamic auto-activation", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({ defaultRoastTools: ["read", "late"] }),
		);
		const allTools = [extensionTool("read"), builtinTool("bash"), builtinTool("write")];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		roastMode(mock.pi);
		const context = createMockContext();

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...REQUIRED_ROAST_TOOLS]);

		allTools.push(extensionTool("late"));
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...REQUIRED_ROAST_TOOLS]);
		await mock.commands.get("roast")?.handler("exit", context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["late", "read", ...REQUIRED_ROAST_TOOLS]);
	});
});

test("the tool selector persists a session override and shutdown restores prior tools", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({ defaultRoastTools: ["bash", "custom"] }),
		);
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("write"),
			extensionTool("custom"),
		];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		roastMode(mock.pi);
		let selectedRead = false;
		const context = createMockContext({
			hasUI: true,
			select: async (_title: unknown, choices: string[]) => {
				if (selectedRead) return "Done — start Roast mode";
				selectedRead = true;
				return choices.find((choice) => choice === "read");
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("tools", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"bash",
			"read",
			"custom",
			...REQUIRED_ROAST_TOOLS,
		]);
		const persisted = mock.entries.at(-1);
		assert.ok(persisted);
		assert.deepEqual((persisted.data as { selectedToolNames?: string[] }).selectedToolNames, [
			"bash",
			"custom",
			"read",
		]);

		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["write"]);

		const resumed = createMockPi({ activeTools: ["write"], allTools });
		roastMode(resumed.pi);
		const stateEntry = { type: "custom", ...persisted };
		const resumedContext = createMockContext({
			sessionManager: {
				getBranch: () => [stateEntry],
				getEntries: () => [stateEntry],
			},
		});
		await resumed.events.get("session_start")?.[0]?.({}, resumedContext.ctx);
		assert.deepEqual(resumed.rawPi.getActiveTools(), [
			"bash",
			"read",
			"custom",
			...REQUIRED_ROAST_TOOLS,
		]);
	});
});

test("the pre-start tool selector keeps the cursor on a draft toggle", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({ defaultRoastTools: ["bash", "custom"] }),
		);
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("write"),
			extensionTool("custom"),
		];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		roastMode(mock.pi);
		let customCalled = false;
		const context = createMockContext({
			hasUI: true,
			custom: async (factory: unknown) => {
				customCalled = true;
				const harness = createCustomSelectorHarness(factory);
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
				await harness.waitForPending();
				assert.ok(harness.render().some((line) => line.includes("› [x] read")));
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("tools", context.ctx);

		assert.equal(customCalled, true);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["write"]);
		assert.equal(mock.entries.length, 0);
	});
});

test("the Roast-mode tool selector searches metadata and toggles the stable tool name", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({ defaultRoastTools: ["bash"] }),
		);
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("write"),
			{ ...extensionTool("custom"), description: "Remote inspection helper" },
		];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		roastMode(mock.pi);
		let customCalled = false;
		const context = createMockContext({
			hasUI: true,
			custom: async (factory: unknown) => {
				customCalled = true;
				const harness = createCustomSelectorHarness(factory, 60);
				for (const input of ["r", "e", "m", "o", "t", "e"]) harness.handleInput(input);
				const filtered = stripVTControlCharacters(harness.render().join("\n"));
				assert.match(filtered, /custom/);
				assert.doesNotMatch(filtered, /› .*bash|› .*read|› .*write/);
				harness.handleInput("tui.select.confirm");
				for (let index = 0; index < 6; index += 1) harness.handleInput("\u007f");
				assert.match(stripVTControlCharacters(harness.render().join("\n")), /› \[x\] custom/);
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
				await harness.waitForPending();
				return harness.result;
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("tools", context.ctx);

		assert.equal(customCalled, true);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", "custom", ...REQUIRED_ROAST_TOOLS]);
		const persisted = mock.entries.at(-1)?.data as { selectedToolNames?: string[] } | undefined;
		assert.deepEqual(persisted?.selectedToolNames, ["bash", "custom"]);
	});
});

test("implementation handoff restores tools after using configured defaults", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-roast-mode.json"),
			JSON.stringify({ defaultRoastTools: ["bash"] }),
		);
		const mock = createMockPi({
			activeTools: ["read", "write", "custom"],
			allTools: [
				builtinTool("read"),
				builtinTool("bash"),
				builtinTool("write"),
				extensionTool("custom"),
			],
		});
		roastMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", ...REQUIRED_ROAST_TOOLS]);

		const execute = mock.tools.find((tool) => tool.name === "roast_mode_complete")?.execute as
			| ((...args: unknown[]) => Promise<unknown>)
			| undefined;
		assert.ok(execute);
		await execute("complete", { roast: "# Configured handoff" }, undefined, undefined, context.ctx);
		await mock.commands.get("roast")?.handler("implement", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write", "custom"]);
		assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Configured handoff/);
	});
});

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-roast-mode-default-tools-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}
