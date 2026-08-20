import assert from "node:assert/strict";
import {
	access,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	awaitRoastModeSettingsWrites,
	configuredImplementationRoastRetention,
	configuredRoastExportPath,
	configuredRoastModeToggleShortcut,
	configuredRoastStyle,
	normalizeRoastModeSettings,
	readRoastModeSettings,
	updateRoastModeSettings,
} from "../src/settings.js";

test("Roast-mode settings validate and configure roast styles", async () => {
	assert.deepEqual(normalizeRoastModeSettings({}), { thinkingLevel: "inherit" });
	assert.deepEqual(normalizeRoastModeSettings({ roastStyle: "linus" }), {
		thinkingLevel: "inherit",
		roastStyle: "linus",
	});
	assert.deepEqual(normalizeRoastModeSettings({ roastStyle: "soft" }), {
		thinkingLevel: "inherit",
		roastStyle: "soft",
	});
	assert.equal(normalizeRoastModeSettings({ roastStyle: "sith-lord" }), undefined);
	assert.equal(
		configuredRoastStyle(normalizeRoastModeSettings({}) ?? { thinkingLevel: "inherit" }),
		"mid",
	);
	assert.equal(
		configuredRoastStyle(
			normalizeRoastModeSettings({ roastStyle: "hard" }) ?? {
				thinkingLevel: "inherit",
			},
		),
		"hard",
	);

	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-test-"));
	try {
		const path = join(directory, "pi-roast-mode.json");
		await writeFile(path, '{"roastStyle":"linus"}');
		assert.deepEqual(await readRoastModeSettings(path), {
			kind: "loaded",
			settings: { thinkingLevel: "inherit", roastStyle: "linus" },
		});
		await updateRoastModeSettings({ roastStyle: "hard" }, { settingsPath: path });
		assert.deepEqual(await readRoastModeSettings(path), {
			kind: "loaded",
			settings: { thinkingLevel: "inherit", roastStyle: "hard" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings validate inherit and fixed thinking levels", async () => {
	assert.deepEqual(normalizeRoastModeSettings({}), { thinkingLevel: "inherit" });
	assert.deepEqual(normalizeRoastModeSettings({ thinkingLevel: "medium" }), {
		thinkingLevel: "medium",
	});
	assert.deepEqual(normalizeRoastModeSettings({ thinkingLevel: "max" }), {
		thinkingLevel: "max",
	});
	assert.equal(normalizeRoastModeSettings({ thinkingLevel: "extreme" }), undefined);

	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-test-"));
	try {
		const path = join(directory, "pi-roast-mode.json");
		await writeFile(path, '{"thinkingLevel":"high"}');
		assert.deepEqual(await readRoastModeSettings(path), {
			kind: "loaded",
			settings: { thinkingLevel: "high" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings normalize and configure toggle shortcut keys", () => {
	assert.deepEqual(normalizeRoastModeSettings({ toggleShortcut: "Ctrl+Alt+P" }), {
		thinkingLevel: "inherit",
		toggleShortcut: "ctrl+alt+p",
	});
	assert.equal(normalizeRoastModeSettings({ toggleShortcut: "bad+key" }), undefined);
	assert.equal(normalizeRoastModeSettings({ toggleShortcut: 42 }), undefined);
	const configured = normalizeRoastModeSettings({});
	assert.ok(configured);
	assert.equal(configuredRoastModeToggleShortcut(configured), undefined);
});

test("Roast-mode settings normalize default tool names strictly", async () => {
	assert.deepEqual(
		normalizeRoastModeSettings({
			thinkingLevel: "medium",
			defaultRoastTools: ["bash", "read", "bash", "grep"],
		}),
		{
			thinkingLevel: "medium",
			defaultRoastTools: ["bash", "read", "grep"],
		},
	);
	assert.deepEqual(normalizeRoastModeSettings({ defaultRoastTools: [] }), {
		thinkingLevel: "inherit",
		defaultRoastTools: [],
	});
	for (const defaultRoastTools of ["read", [""], ["   "], ["read", 42]]) {
		assert.equal(normalizeRoastModeSettings({ defaultRoastTools }), undefined);
	}

	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-default-tools-test-"));
	try {
		const path = join(directory, "pi-roast-mode.json");
		await writeFile(path, '{"defaultRoastTools":["read","bash","read"]}');
		assert.deepEqual(await readRoastModeSettings(path), {
			kind: "loaded",
			settings: {
				thinkingLevel: "inherit",
				defaultRoastTools: ["read", "bash"],
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings validate implementation retention and export defaults", () => {
	for (const implementationRoastRetention of [
		"keep",
		"clear-on-start",
		"clear-after-first-run",
	] as const) {
		const normalized = normalizeRoastModeSettings({ implementationRoastRetention });
		assert.ok(normalized);
		assert.equal(normalized.implementationRoastRetention, implementationRoastRetention);
		assert.equal(configuredImplementationRoastRetention(normalized), implementationRoastRetention);
	}
	assert.equal(
		normalizeRoastModeSettings({ implementationRoastRetention: "clear-eventually" }),
		undefined,
	);

	assert.deepEqual(normalizeRoastModeSettings({ defaultRoastExportPath: "docs/ROAST.md" }), {
		thinkingLevel: "inherit",
		defaultRoastExportPath: "docs/ROAST.md",
	});
	const normalizedPath = normalizeRoastModeSettings({
		defaultRoastExportPath: " docs/ROAST.md ",
	});
	assert.ok(normalizedPath);
	assert.equal(configuredRoastExportPath(normalizedPath), "docs/ROAST.md");
	const defaults = normalizeRoastModeSettings({});
	assert.ok(defaults);
	assert.equal(configuredImplementationRoastRetention(defaults), "keep");
	assert.equal(configuredRoastExportPath(defaults), "ROAST.md");
	for (const defaultRoastExportPath of [
		"",
		"   ",
		"bad\0path",
		"bad\u001bpath",
		"x".repeat(4097),
		42,
	]) {
		assert.equal(normalizeRoastModeSettings({ defaultRoastExportPath }), undefined);
	}
});

test("Roast-mode settings ignore unknown top-level fields", () => {
	assert.deepEqual(
		normalizeRoastModeSettings({
			thinkingLevel: "medium",
			futureOption: { enabled: true },
		}),
		{ thinkingLevel: "medium" },
	);
});

test("Roast-mode settings validate safe subcommands strictly", async () => {
	assert.deepEqual(
		normalizeRoastModeSettings({
			thinkingLevel: "medium",
			defaultRoastTools: ["read", "bash"],
			safeSubcommands: {
				git: ["status", "rev-parse", "status", "cat-file"],
				gh: ["pr view", "issue list", "pr view"],
			},
		}),
		{
			thinkingLevel: "medium",
			defaultRoastTools: ["read", "bash"],
			safeSubcommands: {
				git: ["status", "rev-parse", "cat-file"],
				gh: ["pr view", "issue list"],
			},
		},
	);
	assert.deepEqual(normalizeRoastModeSettings({ safeSubcommands: {} }), {
		thinkingLevel: "inherit",
		safeSubcommands: {},
	});
	assert.deepEqual(normalizeRoastModeSettings({ safeSubcommands: { git: [], gh: [] } }), {
		thinkingLevel: "inherit",
		safeSubcommands: { git: [], gh: [] },
	});

	for (const safeSubcommands of [
		null,
		[],
		{ kubectl: ["get"] },
		{ git: "status" },
		{ git: ["checkout"] },
		{ git: ["status", 42] },
		{ gh: ["pr merge"] },
		{ gh: ["pr view", ""] },
	]) {
		assert.equal(normalizeRoastModeSettings({ safeSubcommands }), undefined);
	}
});

test("Roast-mode settings updates create only on explicit save and preserve unknown fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-settings-update-"));
	const settingsPath = join(directory, "nested", "pi-roast-mode.json");
	try {
		assert.deepEqual(await readRoastModeSettings(settingsPath), { kind: "missing" });
		await assert.rejects(access(settingsPath));

		await updateRoastModeSettings(
			{ thinkingLevel: "high", defaultRoastTools: ["read", "bash"] },
			{ settingsPath },
		);
		await writeFile(
			settingsPath,
			'{"future":{"kept":true},"thinkingLevel":"high","defaultRoastTools":["read","bash"],"safeSubcommands":{"gh":["pr view"]}}\n',
		);
		await updateRoastModeSettings(
			{ thinkingLevel: "medium", defaultRoastTools: null },
			{ settingsPath },
		);

		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			future: { kept: true },
			thinkingLevel: "medium",
			safeSubcommands: { gh: ["pr view"] },
		});
		assert.deepEqual(await readRoastModeSettings(settingsPath), {
			kind: "loaded",
			settings: {
				thinkingLevel: "medium",
				safeSubcommands: { gh: ["pr view"] },
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings patch retention and export fields from the latest document", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-settings-new-fields-"));
	const settingsPath = join(directory, "pi-roast-mode.json");
	try {
		await writeFile(
			settingsPath,
			'{"thinkingLevel":"low","future":{"kept":true},"defaultRoastExportPath":"old.md"}\n',
		);
		await updateRoastModeSettings(
			{
				implementationRoastRetention: "clear-after-first-run",
				defaultRoastExportPath: "docs/ROAST.md",
			},
			{ settingsPath },
		);
		await updateRoastModeSettings({ defaultRoastExportPath: null }, { settingsPath });

		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			thinkingLevel: "low",
			future: { kept: true },
			implementationRoastRetention: "clear-after-first-run",
		});
		assert.deepEqual(await readRoastModeSettings(settingsPath), {
			kind: "loaded",
			settings: {
				thinkingLevel: "low",
				implementationRoastRetention: "clear-after-first-run",
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings explicit save promotes valid legacy content without modifying it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-settings-promote-"));
	const settingsPath = join(directory, "pi-roast-mode.json");
	const legacySettingsPath = join(directory, "roast-mode.json");
	const legacy =
		'{"thinkingLevel":"low","defaultRoastTools":["read"],"implementationRoastRetention":"clear-on-start","defaultRoastExportPath":"roasts/ROAST.md","future":{"kept":true}}\n';
	try {
		await writeFile(legacySettingsPath, legacy);
		await updateRoastModeSettings({ thinkingLevel: "high" }, { settingsPath, legacySettingsPath });

		assert.equal(await readFile(legacySettingsPath, "utf8"), legacy);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			thinkingLevel: "high",
			defaultRoastTools: ["read"],
			implementationRoastRetention: "clear-on-start",
			defaultRoastExportPath: "roasts/ROAST.md",
			future: { kept: true },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings refuse invalid documents and preserve atomic publication failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-settings-invalid-"));
	const settingsPath = join(directory, "pi-roast-mode.json");
	try {
		for (const invalid of ["{mock-sensitive-token", '{"thinkingLevel":"huge"}\n']) {
			await writeFile(settingsPath, invalid);
			await assert.rejects(
				updateRoastModeSettings({ thinkingLevel: "high" }, { settingsPath }),
				(error: unknown) => {
					assert.match(String(error), /invalid (?:JSON|settings shape)/i);
					assert.doesNotMatch(String(error), /mock-sensitive-token/);
					return true;
				},
			);
			assert.equal(await readFile(settingsPath, "utf8"), invalid);
		}

		const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
		await writeFile(settingsPath, invalidUtf8);
		const invalidUtf8Result = await readRoastModeSettings(settingsPath);
		assert.match(invalidUtf8Result.kind === "invalid" ? invalidUtf8Result.reason : "", /UTF-8/i);
		await assert.rejects(
			updateRoastModeSettings({ thinkingLevel: "high" }, { settingsPath }),
			/UTF-8/i,
		);
		assert.deepEqual(await readFile(settingsPath), invalidUtf8);

		const oversized = Buffer.alloc(64 * 1024 + 1, 0x20);
		await writeFile(settingsPath, oversized);
		const oversizedResult = await readRoastModeSettings(settingsPath);
		assert.match(
			oversizedResult.kind === "invalid" ? oversizedResult.reason : "",
			/exceeds .* bytes/i,
		);
		await assert.rejects(
			updateRoastModeSettings({ thinkingLevel: "high" }, { settingsPath }),
			/exceeds .* bytes/i,
		);
		assert.deepEqual(await readFile(settingsPath), oversized);

		await writeFile(settingsPath, '{"thinkingLevel":"low","future":true}\n');
		const before = await readFile(settingsPath, "utf8");
		await assert.rejects(
			updateRoastModeSettings(
				{ thinkingLevel: "high" },
				{
					settingsPath,
					beforeRename: async () => {
						throw new Error("publication failed");
					},
				},
			),
			/publication failed/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), before);
		assert.deepEqual(await readdir(directory), ["pi-roast-mode.json"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings serialize updates, coordinate reads, and recover after failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-settings-order-"));
	const settingsPath = join(directory, "pi-roast-mode.json");
	let releaseFirst!: () => void;
	let markFirstReached!: () => void;
	const firstReached = new Promise<void>((resolve) => {
		markFirstReached = resolve;
	});
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	try {
		const first = updateRoastModeSettings(
			{ thinkingLevel: "low" },
			{
				settingsPath,
				beforeRename: async () => {
					markFirstReached();
					await firstGate;
				},
			},
		);
		const second = updateRoastModeSettings(
			{
				thinkingLevel: "medium",
				implementationRoastRetention: "clear-after-first-run",
			},
			{ settingsPath },
		);
		const third = updateRoastModeSettings(
			{ defaultRoastExportPath: "ordered/ROAST.md" },
			{ settingsPath },
		);
		const coordinatedRead = readRoastModeSettings(settingsPath);
		await firstReached;
		releaseFirst();
		await Promise.all([first, second, third]);
		assert.deepEqual(await coordinatedRead, {
			kind: "loaded",
			settings: {
				thinkingLevel: "medium",
				implementationRoastRetention: "clear-after-first-run",
				defaultRoastExportPath: "ordered/ROAST.md",
			},
		});

		await assert.rejects(
			updateRoastModeSettings(
				{ thinkingLevel: "high" },
				{
					settingsPath,
					beforeRename: async () => Promise.reject(new Error("failed once")),
				},
			),
			/failed once/,
		);
		await updateRoastModeSettings({ thinkingLevel: "max" }, { settingsPath });
		await awaitRoastModeSettingsWrites(settingsPath);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			thinkingLevel: "max",
			implementationRoastRetention: "clear-after-first-run",
			defaultRoastExportPath: "ordered/ROAST.md",
		});
	} finally {
		releaseFirst();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings abort before publication without creating the canonical file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-settings-abort-"));
	const settingsPath = join(directory, "pi-roast-mode.json");
	const controller = new AbortController();
	try {
		await assert.rejects(
			updateRoastModeSettings(
				{ thinkingLevel: "high" },
				{
					settingsPath,
					signal: controller.signal,
					beforeRename: async () => controller.abort(new Error("settings disposed")),
				},
			),
			/settings disposed/,
		);
		await assert.rejects(access(settingsPath));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Roast-mode settings read legacy files without modifying them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-roast-mode-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(
			join(directory, "roast-mode.json"),
			'{"thinkingLevel":"high","safeSubcommands":{"gh":["pr view"]},"futureOption":true}',
		);
		const loaded = await readRoastModeSettings();
		assert.equal(loaded.kind, "loaded");
		assert.deepEqual(loaded.kind === "loaded" ? loaded.settings : undefined, {
			thinkingLevel: "high",
			safeSubcommands: { gh: ["pr view"] },
		});
		assert.match(loaded.notice ?? "", /using legacy/i);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "roast-mode.json"), "utf8")), {
			thinkingLevel: "high",
			safeSubcommands: { gh: ["pr view"] },
			futureOption: true,
		});
		await assert.rejects(access(join(directory, "pi-roast-mode.json")));

		await writeFile(join(directory, "roast-mode.json"), '{"thinkingLevel":"low"}');
		await writeFile(join(directory, "pi-roast-mode.json"), '{"thinkingLevel":"medium"}');
		const preferred = await readRoastModeSettings();
		assert.deepEqual(preferred.kind === "loaded" ? preferred.settings : undefined, {
			thinkingLevel: "medium",
		});
		assert.match(preferred.notice ?? "", /ignored/i);

		await writeFile(join(directory, "pi-roast-mode.json"), "invalid");
		const invalid = await readRoastModeSettings();
		assert.equal(invalid.kind, "invalid");
		assert.equal(
			await readFile(join(directory, "roast-mode.json"), "utf8"),
			'{"thinkingLevel":"low"}',
		);

		await unlink(join(directory, "pi-roast-mode.json"));
		await writeFile(join(directory, "roast-mode.json"), "invalid");
		assert.equal((await readRoastModeSettings()).kind, "invalid");
		await assert.rejects(access(join(directory, "pi-roast-mode.json")));

		await writeFile(join(directory, "roast-mode.json"), '{"thinkingLevel":"high"}');
		await symlink("missing-target", join(directory, "pi-roast-mode.json"));
		const linked = await readRoastModeSettings();
		assert.equal(linked.kind, "invalid");
		assert.match(linked.kind === "invalid" ? linked.reason : "", /regular file/i);
		assert.equal(
			await readFile(join(directory, "roast-mode.json"), "utf8"),
			'{"thinkingLevel":"high"}',
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});
