import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import roastMode, { completeRoastArguments } from "../src/roast-mode.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

const ROAST = "# Exported roast\n\n1. Keep the exact roast.\n2. Make it readable to the agent.";
const STATE_ENTRY_TYPE = "roast-mode-state";

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: STATE_ENTRY_TYPE, data };
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

async function withTempDirectory(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-export-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("roast export autocomplete exposes a path-taking public route", () => {
	assert.deepEqual(
		completeRoastArguments("")?.map((item) => item.value),
		["start", "show", "finalize", "implement", "save", "export", "exit", "off", "tools"],
	);
	assert.deepEqual(
		completeRoastArguments("ex")?.map((item) => item.value),
		["export", "exit"],
	);
	assert.equal(completeRoastArguments("export "), null);
});

test("ready roast export ends Roast mode without triggering a model turn", async () => {
	await withTempDirectory(async (directory) => {
		const mock = createMockPi({
			activeTools: ["read", "edit"],
			thinkingLevel: "low",
		});
		roastMode(mock.pi, {
			readSettings: async () => ({
				kind: "loaded" as const,
				settings: { thinkingLevel: "medium" as const },
			}),
		});
		const context = createMockContext({ cwd: directory, hasUI: true });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
		await completeRoast(mock, context.ctx);
		const entriesBeforeExport = mock.entries.length;

		await mock.commands.get("roast")?.handler("export", context.ctx);

		assert.equal(await readFile(join(directory, "ROAST.md"), "utf8"), `${ROAST}\n`);
		assert.equal(context.statuses.get("roast-mode"), undefined);
		assert.equal(mock.entries.length, entriesBeforeExport + 1);
		const persistedState = mock.entries.at(-1)?.data as Record<string, unknown>;
		assert.equal(persistedState.enabled, false);
		assert.equal(persistedState.latestRoast, undefined);
		assert.equal(persistedState.awaitingAction, false);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);
		assert.equal(mock.thinkingLevel, "low");
		assert.equal(mock.sentUserMessages.length, 0);
		assert.equal(mock.sentMessages.length, 0);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/exported.*ROAST\.md.*Roast mode disabled/i,
		);
	});
});

test("configured export defaults resolve at action time and explicit paths still win", async () => {
	await withTempDirectory(async (directory) => {
		for (const { command, expectedPath } of [
			{ command: "export", expectedPath: join(directory, "roasts", "default.md") },
			{ command: "export explicit.md", expectedPath: join(directory, "explicit.md") },
		]) {
			const mock = createMockPi({ activeTools: ["read"] });
			roastMode(mock.pi, {
				readSettings: async () => ({
					kind: "loaded" as const,
					settings: {
						thinkingLevel: "inherit" as const,
						defaultRoastExportPath: "@roasts/default.md",
					},
				}),
			});
			const context = createMockContext({ cwd: directory, hasUI: true });
			await mock.events.get("session_start")?.[0]?.({}, context.ctx);
			await mock.commands.get("roast")?.handler("start", context.ctx);
			await completeRoast(mock, context.ctx);
			await mock.commands.get("roast")?.handler(command, context.ctx);
			assert.equal(await readFile(expectedPath, "utf8"), `${ROAST}\n`);
		}
	});
});

test("relative configured defaults resolve against the command context cwd", async () => {
	await withTempDirectory(async (directory) => {
		const roastingDirectory = join(directory, "roasting");
		const exportDirectory = join(directory, "implementation");
		await mkdir(roastingDirectory);
		await mkdir(exportDirectory);
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi, {
			readSettings: async () => ({
				kind: "loaded" as const,
				settings: {
					thinkingLevel: "inherit" as const,
					defaultRoastExportPath: "roasts/default.md",
				},
			}),
		});
		const roastingContext = createMockContext({ cwd: roastingDirectory, hasUI: true });
		await mock.events.get("session_start")?.[0]?.({}, roastingContext.ctx);
		await mock.commands.get("roast")?.handler("start", roastingContext.ctx);
		await completeRoast(mock, roastingContext.ctx);

		const exportContext = createMockContext({ cwd: exportDirectory, hasUI: true });
		await mock.commands.get("roast")?.handler("export", exportContext.ctx);
		assert.equal(
			await readFile(join(exportDirectory, "roasts", "default.md"), "utf8"),
			`${ROAST}\n`,
		);
		await assert.rejects(readFile(join(roastingDirectory, "roasts", "default.md"), "utf8"));
	});
});

test("an active Settings save changes the next export without changing active state", async () => {
	await withTempDirectory(async (directory) => {
		const settingsPath = join(directory, "pi-roast-mode.json");
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		roastMode(mock.pi, {
			settingsPath,
			readSettings: async () => ({
				kind: "loaded" as const,
				settings: { thinkingLevel: "inherit" as const },
			}),
		});
		let openedSettings = false;
		let changedExport = false;
		const context = createMockContext({
			cwd: directory,
			mode: "tui",
			hasUI: true,
			select: async (_title: string, options: string[]) => {
				if (options.includes("Settings")) {
					if (openedSettings) return undefined;
					openedSettings = true;
					return "Settings";
				}
				if (changedExport) return undefined;
				changedExport = true;
				return options.find((option) => option.startsWith("Export destination"));
			},
			input: async () => "next/export.md",
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);
		await mock.commands.get("roast")?.handler("implement", context.ctx);
		await mock.commands.get("roast")?.handler("", context.ctx);
		assert.equal(context.statuses.get("roast-mode"), "roast implementing");

		await mock.commands.get("roast")?.handler("export", context.ctx);
		assert.equal(await readFile(join(directory, "next", "export.md"), "utf8"), `${ROAST}\n`);
		assert.equal(context.statuses.get("roast-mode"), "roast implementing");
	});
});

test("ready roast export supports custom relative and absolute paths", async () => {
	await withTempDirectory(async (directory) => {
		for (const { requestedPath, expectedPath } of [
			{
				requestedPath: "docs/custom roast.md",
				expectedPath: join(directory, "docs", "custom roast.md"),
			},
			{
				requestedPath: join(directory, "absolute-roast.md"),
				expectedPath: join(directory, "absolute-roast.md"),
			},
		]) {
			const mock = createMockPi({ activeTools: ["read"] });
			roastMode(mock.pi);
			const context = createMockContext({ cwd: directory, hasUI: true });
			await mock.commands.get("roast")?.handler("start", context.ctx);
			await completeRoast(mock, context.ctx);

			await mock.commands.get("roast")?.handler(`export ${requestedPath}`, context.ctx);

			assert.equal(await readFile(expectedPath, "utf8"), `${ROAST}\n`);
			assert.equal(context.statuses.get("roast-mode"), undefined);
			assert.equal(containsTerminalControl(context.notifications.at(-1)?.message ?? ""), false);
		}
	});
});

test("roast export refuses existing files and leaves their content and roast state unchanged", async () => {
	await withTempDirectory(async (directory) => {
		const existingPath = join(directory, "ROAST.md");
		await writeFile(existingPath, "user-owned content\n", "utf8");
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		const context = createMockContext({ cwd: directory, hasUI: true });
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);
		const entriesBeforeExport = mock.entries.length;

		await mock.commands.get("roast")?.handler("export", context.ctx);

		assert.equal(await readFile(existingPath, "utf8"), "user-owned content\n");
		assert.equal(context.statuses.get("roast-mode"), "roast ready");
		assert.equal(mock.entries.length, entriesBeforeExport);
		assert.match(context.notifications.at(-1)?.message ?? "", /already exists/i);
	});
});

test("concurrent exports serialize and create the target only once", async () => {
	await withTempDirectory(async (directory) => {
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		const context = createMockContext({ cwd: directory, hasUI: true });
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);

		await Promise.all([
			mock.commands.get("roast")?.handler("export shared.md", context.ctx),
			mock.commands.get("roast")?.handler("export shared.md", context.ctx),
		]);

		assert.equal(await readFile(join(directory, "shared.md"), "utf8"), `${ROAST}\n`);
		assert.equal(
			context.notifications.filter((notification) =>
				/Roast exported to/u.test(notification.message),
			).length,
			1,
		);
		assert.equal(
			context.notifications.filter((notification) => /already exists/u.test(notification.message))
				.length,
			0,
		);
		assert.equal(context.statuses.get("roast-mode"), undefined);
	});
});

test("queued export stops when the ready roast is superseded", async () => {
	await withTempDirectory(async (directory) => {
		const exportPath = join(directory, "ROAST.md");
		let releaseMutation!: () => void;
		let markMutationHeld!: () => void;
		const mutationHeld = new Promise<void>((resolve) => {
			markMutationHeld = resolve;
		});
		const mutationRelease = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const blocker = withFileMutationQueue(exportPath, async () => {
			markMutationHeld();
			await mutationRelease;
		});
		await mutationHeld;

		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		const context = createMockContext({ cwd: directory, hasUI: true });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);
		const pendingExport = mock.commands.get("roast")?.handler("export", context.ctx);
		await Promise.resolve();
		await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, context.ctx);
		releaseMutation();
		await blocker;
		await pendingExport;

		await assert.rejects(readFile(exportPath, "utf8"), /ENOENT/u);
		assert.equal(context.statuses.get("roast-mode"), "roast active");
		assert.equal(
			context.notifications.some((notification) => /Roast exported to/u.test(notification.message)),
			false,
		);
	});
});

test("roast export refuses an existing symbolic link", {
	skip: process.platform === "win32",
}, async () => {
	await withTempDirectory(async (directory) => {
		const targetPath = join(directory, "owned.md");
		const exportPath = join(directory, "ROAST.md");
		await writeFile(targetPath, "user-owned content\n", "utf8");
		await symlink(targetPath, exportPath);
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		const context = createMockContext({ cwd: directory, hasUI: true });
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);

		await mock.commands.get("roast")?.handler("export", context.ctx);

		assert.equal(await readFile(targetPath, "utf8"), "user-owned content\n");
		assert.equal((await lstat(exportPath)).isSymbolicLink(), true);
		assert.match(context.notifications.at(-1)?.message ?? "", /already exists/i);
	});
});

test("configured export defaults support saved and active roasts in print and JSON modes", async () => {
	for (const scenario of [
		{
			mode: "print",
			status: "roast saved",
			data: {
				enabled: false,
				awaitingAction: false,
				savedRoast: { roast: ROAST, source: "roast_mode_complete" },
			},
		},
		{
			mode: "json",
			status: "roast implementing",
			data: {
				enabled: false,
				awaitingAction: false,
				activeImplementation: {
					id: "implementation-1",
					roast: ROAST,
					source: "roast_mode_complete",
					startedAt: 42,
				},
			},
		},
	] as const) {
		await withTempDirectory(async (directory) => {
			const entry = stateEntry(scenario.data);
			const mock = createMockPi({ activeTools: ["read", "edit"] });
			roastMode(mock.pi, {
				readSettings: async () => ({
					kind: "loaded" as const,
					settings: {
						thinkingLevel: "inherit" as const,
						defaultRoastExportPath: `${scenario.mode}-default.md`,
					},
				}),
			});
			const context = createMockContext({
				cwd: directory,
				mode: scenario.mode,
				hasUI: false,
				sessionManager: {
					getBranch: () => [entry],
					getEntries: () => [entry],
				},
			});
			await mock.events.get("session_start")?.[0]?.({}, context.ctx);

			await mock.commands.get("roast")?.handler("export", context.ctx);

			assert.equal(
				await readFile(join(directory, `${scenario.mode}-default.md`), "utf8"),
				`${ROAST}\n`,
			);
			assert.equal(context.statuses.get("roast-mode"), scenario.status);
			assert.equal(mock.entries.length, 0);
			assert.equal(mock.sentUserMessages.length, 0);
		});
	}
});

test("roast export fails observably without a roast or on an existing path in no-UI modes", async () => {
	await withTempDirectory(async (directory) => {
		const missing = createMockPi({ activeTools: ["read"] });
		roastMode(missing.pi);
		const printContext = createMockContext({ cwd: directory, mode: "print", hasUI: false });
		await assert.rejects(
			missing.commands.get("roast")?.handler("export", printContext.ctx) as Promise<unknown>,
			/no completed roast/i,
		);

		const savedEntry = stateEntry({
			enabled: false,
			awaitingAction: false,
			savedRoast: { roast: ROAST, source: "roast_mode_complete" },
		});
		await writeFile(join(directory, "ROAST.md"), "keep\n", "utf8");
		const existing = createMockPi({ activeTools: ["read"] });
		roastMode(existing.pi);
		const jsonContext = createMockContext({
			cwd: directory,
			mode: "json",
			hasUI: false,
			sessionManager: {
				getBranch: () => [savedEntry],
				getEntries: () => [savedEntry],
			},
		});
		await existing.events.get("session_start")?.[0]?.({}, jsonContext.ctx);
		await assert.rejects(
			existing.commands.get("roast")?.handler("export", jsonContext.ctx) as Promise<unknown>,
			/already exists/i,
		);
		assert.equal(await readFile(join(directory, "ROAST.md"), "utf8"), "keep\n");
		assert.equal(jsonContext.statuses.get("roast-mode"), "roast saved");
	});
});

test("completion and management TUI menus preview and use the configured export default", async () => {
	for (const scenario of ["automatic-ready", "manual-ready", "saved", "active"] as const) {
		await withTempDirectory(async (directory) => {
			const expectedPath = "configured/default-roast.md";
			const mock = createMockPi({ activeTools: ["read", "edit"] });
			roastMode(mock.pi, {
				readSettings: async () => ({
					kind: "loaded" as const,
					settings: {
						thinkingLevel: "inherit" as const,
						defaultRoastExportPath: expectedPath,
					},
				}),
			});
			const custom = async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory);
				if (!harness.isFocusable) {
					chooseExportMenu(harness);
					return harness.resultPromise;
				}
				const exportFrame = harness.render().join("\n");
				assert.match(exportFrame, /Export roast/is);
				assert.match(exportFrame, /configured\/default-roast\.md/i);
				assert.match(exportFrame, /Resolves to:/i);
				harness.setFocused(true);
				harness.handleInput("tui.input.submit");
				await harness.waitForPending();
				return harness.resultPromise;
			};
			const baseContext = {
				cwd: directory,
				mode: "tui",
				hasUI: true,
				custom,
			};
			const context = createMockContext(
				scenario === "saved"
					? {
							...baseContext,
							sessionManager: {
								getBranch: () => [
									stateEntry({
										enabled: false,
										awaitingAction: false,
										savedRoast: { roast: ROAST, source: "roast_mode_complete" },
									}),
								],
								getEntries: () => [],
							},
						}
					: baseContext,
			);

			await mock.events.get("session_start")?.[0]?.({}, context.ctx);
			if (scenario === "saved") {
				await mock.commands.get("roast")?.handler("", context.ctx);
				assert.equal(context.statuses.get("roast-mode"), "roast saved");
			} else {
				await mock.commands.get("roast")?.handler("start", context.ctx);
				await completeRoast(mock, context.ctx);
				if (scenario === "automatic-ready") {
					await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
				} else if (scenario === "manual-ready") {
					await mock.commands.get("roast")?.handler("", context.ctx);
				} else {
					await mock.commands.get("roast")?.handler("implement", context.ctx);
					await mock.commands.get("roast")?.handler("", context.ctx);
					assert.equal(context.statuses.get("roast-mode"), "roast implementing");
				}
			}

			assert.equal(await readFile(join(directory, expectedPath), "utf8"), `${ROAST}\n`);
			assert.equal(
				context.statuses.get("roast-mode"),
				scenario === "active"
					? "roast implementing"
					: scenario === "saved"
						? "roast saved"
						: undefined,
			);
			assert.equal(mock.sentUserMessages.length, scenario === "active" ? 1 : 0);
		});
	}
});

function containsTerminalControl(value: string) {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return (
			codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		);
	});
}

function chooseExportMenu(harness: ReturnType<typeof createCustomSelectorHarness>) {
	for (let index = 0; index < 10; index += 1) {
		if (selectedMenuLabel(harness.render()).startsWith("Export roast")) break;
		harness.handleInput("tui.select.down");
	}
	assert.match(selectedMenuLabel(harness.render()), /^Export roast/u);
	harness.handleInput("tui.select.confirm");
}

function selectedMenuLabel(lines: readonly string[]) {
	const line = lines.find((candidate) => candidate.startsWith("→ ") || candidate.startsWith("› "));
	return line
		? (line
				.slice(2)
				.split(/\s{2,}/u)[0]
				?.trim() ?? "")
		: "";
}

test("RPC export menu exposes and uses the configured default", async () => {
	await withTempDirectory(async (directory) => {
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi, {
			readSettings: async () => ({
				kind: "loaded" as const,
				settings: {
					thinkingLevel: "inherit" as const,
					defaultRoastExportPath: "rpc-default.md",
				},
			}),
		});
		let inputCalls = 0;
		const context = createMockContext({
			cwd: directory,
			mode: "rpc",
			hasUI: true,
			select: async (_title: string, options: string[]) => {
				assert.ok(options.includes("Export roast…"));
				return "Export roast…";
			},
			input: async (title: string, placeholder?: string) => {
				inputCalls += 1;
				assert.match(title, /Export roast/i);
				assert.match(title, /Resolves to:.*rpc-default\.md/is);
				assert.equal(placeholder, "rpc-default.md");
				return "";
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);

		await mock.commands.get("roast")?.handler("", context.ctx);

		assert.equal(inputCalls, 1);
		assert.equal(await readFile(join(directory, "rpc-default.md"), "utf8"), `${ROAST}\n`);
		assert.equal(context.statuses.get("roast-mode"), undefined);
	});
});

test("rejected TUI export retains the path draft for correction", async () => {
	await withTempDirectory(async (directory) => {
		await writeFile(join(directory, "ROAST.md"), "keep\n", "utf8");
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		const context = createMockContext({
			cwd: directory,
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory);
				if (!harness.isFocusable) {
					chooseExportMenu(harness);
					return harness.resultPromise;
				}
				harness.setFocused(true);
				harness.handleInput("ROAST.md");
				harness.handleInput("tui.input.submit");
				await harness.waitForPending();

				assert.equal(harness.result, undefined);
				assert.equal(harness.isFocusable, true);
				assert.match(harness.render().join("\n"), /ROAST\.md/u);
				assert.match(context.notifications.at(-1)?.message ?? "", /already exists/i);

				harness.handleInput("\u0015");
				harness.handleInput("corrected.md");
				harness.handleInput("tui.input.submit");
				await harness.waitForPending();
				return harness.resultPromise;
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);

		await mock.commands.get("roast")?.handler("", context.ctx);

		assert.equal(await readFile(join(directory, "ROAST.md"), "utf8"), "keep\n");
		assert.equal(await readFile(join(directory, "corrected.md"), "utf8"), `${ROAST}\n`);
		assert.equal(context.statuses.get("roast-mode"), undefined);
	});
});

test("Back from the export input returns without writing or changing ready state", async () => {
	await withTempDirectory(async (directory) => {
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		let returnedFromInput = false;
		const context = createMockContext({
			cwd: directory,
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory);
				if (harness.isFocusable) {
					returnedFromInput = true;
					harness.handleInput("tui.select.cancel");
					return harness.resultPromise;
				}
				if (!returnedFromInput) chooseExportMenu(harness);
				else harness.handleInput("tui.select.cancel");
				return harness.resultPromise;
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);
		const entriesBeforeMenu = mock.entries.length;

		await mock.commands.get("roast")?.handler("", context.ctx);

		await assert.rejects(readFile(join(directory, "ROAST.md"), "utf8"), /ENOENT/u);
		assert.equal(context.statuses.get("roast-mode"), "roast ready");
		assert.equal(mock.entries.length, entriesBeforeMenu);
	});
});

test("pending export is cancelled by disposal, session replacement, and shutdown", async () => {
	for (const ending of ["dispose", "replacement", "shutdown"] as const) {
		await withTempDirectory(async (directory) => {
			const exportPath = join(directory, "ROAST.md");
			let releaseMutation!: () => void;
			let markMutationHeld!: () => void;
			const mutationHeld = new Promise<void>((resolve) => {
				markMutationHeld = resolve;
			});
			const mutationRelease = new Promise<void>((resolve) => {
				releaseMutation = resolve;
			});
			const blocker = withFileMutationQueue(exportPath, async () => {
				markMutationHeld();
				await mutationRelease;
			});
			await mutationHeld;

			let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
			let markSubmitted!: () => void;
			let releaseDisposed!: () => void;
			const submitted = new Promise<void>((resolve) => {
				markSubmitted = resolve;
			});
			const externallyDisposed = new Promise<void>((resolve) => {
				releaseDisposed = resolve;
			});
			const mock = createMockPi({ activeTools: ["read"] });
			roastMode(mock.pi);
			const context = createMockContext({
				cwd: directory,
				mode: "tui",
				hasUI: true,
				custom: async (factory: unknown) => {
					const currentHarness = createCustomSelectorHarness(factory);
					if (!currentHarness.isFocusable) {
						chooseExportMenu(currentHarness);
						return currentHarness.resultPromise;
					}
					harness = currentHarness;
					currentHarness.handleInput("tui.input.submit");
					markSubmitted();
					return ending === "dispose"
						? Promise.race([currentHarness.resultPromise, externallyDisposed])
						: currentHarness.resultPromise;
				},
			});
			await mock.events.get("session_start")?.[0]?.({}, context.ctx);
			await mock.commands.get("roast")?.handler("start", context.ctx);
			await completeRoast(mock, context.ctx);
			const pendingMenu = mock.commands.get("roast")?.handler("", context.ctx);
			await submitted;
			assert.ok(harness);

			try {
				if (ending === "dispose") {
					harness.dispose();
					releaseDisposed();
				} else if (ending === "replacement") {
					await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
				} else await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
			} finally {
				releaseMutation();
			}
			await blocker;
			await pendingMenu;

			await assert.rejects(readFile(exportPath, "utf8"), /ENOENT/u);
			assert.equal(mock.sentUserMessages.length, 0);
			assert.equal(
				context.notifications.some((notification) =>
					/Unable to export roast/u.test(notification.message),
				),
				false,
			);
		});
	}
});

test("roast export refuses an existing directory", async () => {
	await withTempDirectory(async (directory) => {
		await mkdir(join(directory, "ROAST.md"));
		const mock = createMockPi({ activeTools: ["read"] });
		roastMode(mock.pi);
		const context = createMockContext({ cwd: directory, hasUI: true });
		await mock.commands.get("roast")?.handler("start", context.ctx);
		await completeRoast(mock, context.ctx);
		await mock.commands.get("roast")?.handler("export", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /already exists/i);
	});
});
