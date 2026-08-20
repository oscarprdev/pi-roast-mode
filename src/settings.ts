import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
	SAFE_GH_SUBCOMMAND_PATHS,
	SAFE_GIT_SUBCOMMANDS,
	type SafeGhSubcommandPath,
	type SafeGitSubcommand,
	type SafeSubcommands,
} from "./tool-policy.js";

export const ROAST_MODE_SETTINGS_FILE = "pi-roast-mode.json";
const LEGACY_ROAST_MODE_SETTINGS_FILE = "roast-mode.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
export const ROAST_STYLES = ["soft", "mid", "hard", "linus"] as const;
export const ROAST_MODE_THINKING_LEVELS = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export const IMPLEMENTATION_ROAST_RETENTIONS = [
	"keep",
	"clear-on-start",
	"clear-after-first-run",
] as const;
export const DEFAULT_ROAST_EXPORT_PATH = "ROAST.md";
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_unused, index) => `f${index + 1}`),
]);
const MAX_ROAST_EXPORT_PATH_LENGTH = 4096;

export type RoastStyle = (typeof ROAST_STYLES)[number];
export type RoastModeThinkingLevel = (typeof ROAST_MODE_THINKING_LEVELS)[number];
export type ImplementationRoastRetention = (typeof IMPLEMENTATION_ROAST_RETENTIONS)[number];
export type RoastModeFixedThinkingLevel = Exclude<RoastModeThinkingLevel, "inherit">;
export interface RoastModeSettings {
	thinkingLevel: RoastModeThinkingLevel;
	roastStyle?: RoastStyle;
	defaultRoastTools?: string[];
	implementationRoastRetention?: ImplementationRoastRetention;
	defaultRoastExportPath?: string;
	safeSubcommands?: SafeSubcommands;
	toggleShortcut?: KeyId;
}
export interface RoastModeSettingsPatch {
	thinkingLevel?: RoastModeThinkingLevel;
	roastStyle?: RoastStyle;
	defaultRoastTools?: readonly string[] | null;
	implementationRoastRetention?: ImplementationRoastRetention;
	defaultRoastExportPath?: string | null;
	toggleShortcut?: KeyId | null;
}
export interface UpdateRoastModeSettingsOptions {
	settingsPath?: string;
	legacySettingsPath?: string;
	signal?: AbortSignal;
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}
export type RoastModeSettingsLoadResult =
	| { kind: "missing"; notice?: string }
	| { kind: "invalid"; reason: string; notice?: string }
	| { kind: "loaded"; settings: RoastModeSettings; notice?: string };

type SettingsDocument = Record<string, unknown>;
type SettingsSnapshot = {
	result: RoastModeSettingsLoadResult;
	document?: SettingsDocument;
};

const mutationQueues = new Map<string, Promise<void>>();

export function roastModeSettingsPath() {
	return join(getAgentDir(), ROAST_MODE_SETTINGS_FILE);
}

function legacyRoastModeSettingsPath() {
	return join(getAgentDir(), LEGACY_ROAST_MODE_SETTINGS_FILE);
}

export function normalizeRoastModeSettings(value: unknown): RoastModeSettings | undefined {
	if (!isSettingsDocument(value)) return undefined;
	const thinkingLevel = Object.hasOwn(value, "thinkingLevel")
		? Reflect.get(value, "thinkingLevel")
		: "inherit";
	if (!ROAST_MODE_THINKING_LEVELS.includes(thinkingLevel as RoastModeThinkingLevel)) {
		return undefined;
	}
	const settings: RoastModeSettings = {
		thinkingLevel: thinkingLevel as RoastModeThinkingLevel,
	};
	if (Object.hasOwn(value, "roastStyle")) {
		const roastStyle = Reflect.get(value, "roastStyle");
		if (!ROAST_STYLES.includes(roastStyle as RoastStyle)) {
			return undefined;
		}
		settings.roastStyle = roastStyle as RoastStyle;
	}
	if (Object.hasOwn(value, "defaultRoastTools")) {
		const defaultRoastTools = normalizeToolNames(Reflect.get(value, "defaultRoastTools"));
		if (!defaultRoastTools) return undefined;
		settings.defaultRoastTools = defaultRoastTools;
	}
	if (Object.hasOwn(value, "implementationRoastRetention")) {
		const implementationRoastRetention = Reflect.get(value, "implementationRoastRetention");
		if (
			!IMPLEMENTATION_ROAST_RETENTIONS.includes(
				implementationRoastRetention as ImplementationRoastRetention,
			)
		) {
			return undefined;
		}
		settings.implementationRoastRetention =
			implementationRoastRetention as ImplementationRoastRetention;
	}
	if (Object.hasOwn(value, "defaultRoastExportPath")) {
		const defaultRoastExportPath = normalizeRoastExportPath(
			Reflect.get(value, "defaultRoastExportPath"),
		);
		if (!defaultRoastExportPath) return undefined;
		settings.defaultRoastExportPath = defaultRoastExportPath;
	}
	if (Object.hasOwn(value, "toggleShortcut")) {
		const toggleShortcut = normalizeKeyId(Reflect.get(value, "toggleShortcut"));
		if (!toggleShortcut) return undefined;
		settings.toggleShortcut = toggleShortcut;
	}
	if (Object.hasOwn(value, "safeSubcommands")) {
		const safeSubcommands = normalizeSafeSubcommands(Reflect.get(value, "safeSubcommands"));
		if (!safeSubcommands) return undefined;
		settings.safeSubcommands = safeSubcommands;
	}
	return settings;
}

function normalizeToolNames(value: unknown) {
	if (
		!Array.isArray(value) ||
		!value.every((item): item is string => typeof item === "string" && item.trim().length > 0)
	) {
		return undefined;
	}
	return Array.from(new Set(value));
}

function normalizeRoastExportPath(value: unknown) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > MAX_ROAST_EXPORT_PATH_LENGTH ||
		!/[^@\s]/u.test(normalized) ||
		[...normalized].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
		})
	) {
		return undefined;
	}
	return normalized;
}

export function normalizeKeyId(value: unknown): KeyId | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	const base = [...BASE_KEYS]
		.sort((left, right) => right.length - left.length)
		.find((candidate) => normalized === candidate || normalized.endsWith(`+${candidate}`));
	if (!base) return undefined;
	const prefix = normalized.slice(0, normalized.length - base.length);
	if (!prefix) return base as KeyId;
	if (/^f(?:[1-9]|1[0-2])$/.test(base) || !prefix.endsWith("+")) return undefined;
	const modifiers = prefix.slice(0, -1).split("+");
	if (
		modifiers.length === 0 ||
		modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
		new Set(modifiers).size !== modifiers.length
	) {
		return undefined;
	}
	return normalized as KeyId;
}

function normalizeSafeSubcommands(value: unknown): SafeSubcommands | undefined {
	if (!isSettingsDocument(value)) return undefined;
	if (Object.keys(value).some((key) => key !== "git" && key !== "gh")) return undefined;

	const safeSubcommands: SafeSubcommands = {};
	if (Object.hasOwn(value, "git")) {
		const git = normalizeKnownValues(Reflect.get(value, "git"), SAFE_GIT_SUBCOMMANDS);
		if (!git) return undefined;
		safeSubcommands.git = git as SafeGitSubcommand[];
	}
	if (Object.hasOwn(value, "gh")) {
		const gh = normalizeKnownValues(Reflect.get(value, "gh"), SAFE_GH_SUBCOMMAND_PATHS);
		if (!gh) return undefined;
		safeSubcommands.gh = gh as SafeGhSubcommandPath[];
	}
	return safeSubcommands;
}

function normalizeKnownValues(value: unknown, supported: readonly string[]) {
	if (
		!Array.isArray(value) ||
		!value.every((item): item is string => typeof item === "string" && supported.includes(item))
	) {
		return undefined;
	}
	return Array.from(new Set(value));
}

export async function readRoastModeSettings(
	settingsPath?: string,
): Promise<RoastModeSettingsLoadResult> {
	if (settingsPath) {
		await awaitRoastModeSettingsWrites(settingsPath);
		return (await readSettingsSnapshot(settingsPath)).result;
	}
	const canonicalPath = roastModeSettingsPath();
	await awaitRoastModeSettingsWrites(canonicalPath);
	const canonical = await readSettingsSnapshot(canonicalPath);
	const legacyPath = legacyRoastModeSettingsPath();
	if (canonical.result.kind !== "missing") {
		return (await pathExists(legacyPath))
			? {
					...canonical.result,
					notice: `${LEGACY_ROAST_MODE_SETTINGS_FILE} ignored because ${ROAST_MODE_SETTINGS_FILE} takes precedence.`,
				}
			: canonical.result;
	}

	const legacy = await readSettingsSnapshot(legacyPath);
	const raced = await readSettingsSnapshot(canonicalPath);
	if (raced.result.kind !== "missing") return raced.result;
	return legacy.result.kind === "loaded"
		? {
				...legacy.result,
				notice: `Using legacy ${LEGACY_ROAST_MODE_SETTINGS_FILE}; rename it to ${ROAST_MODE_SETTINGS_FILE}. The legacy file was not modified.`,
			}
		: legacy.result;
}

export function updateRoastModeSettings(
	patch: RoastModeSettingsPatch,
	options: UpdateRoastModeSettingsOptions = {},
): Promise<RoastModeSettings> {
	const settingsPath = options.settingsPath ?? roastModeSettingsPath();
	const legacySettingsPath =
		options.legacySettingsPath ??
		(options.settingsPath ? undefined : legacyRoastModeSettingsPath());
	return enqueueMutation(settingsPath, async () => {
		options.signal?.throwIfAborted();
		const current = await readSettingsDocumentForUpdate(settingsPath, legacySettingsPath);
		const updated: SettingsDocument = { ...current };
		if (patch.thinkingLevel !== undefined) updated.thinkingLevel = patch.thinkingLevel;
		if (patch.roastStyle !== undefined) updated.roastStyle = patch.roastStyle;
		if (patch.defaultRoastTools === null) delete updated.defaultRoastTools;
		else if (patch.defaultRoastTools !== undefined) {
			updated.defaultRoastTools = [...patch.defaultRoastTools];
		}
		if (patch.implementationRoastRetention !== undefined) {
			updated.implementationRoastRetention = patch.implementationRoastRetention;
		}
		if (patch.defaultRoastExportPath === null) delete updated.defaultRoastExportPath;
		else if (patch.defaultRoastExportPath !== undefined) {
			updated.defaultRoastExportPath = patch.defaultRoastExportPath;
		}
		if (patch.toggleShortcut === null) delete updated.toggleShortcut;
		else if (patch.toggleShortcut !== undefined) {
			updated.toggleShortcut = patch.toggleShortcut;
		}
		const settings = normalizeRoastModeSettings(updated);
		if (!settings) throw invalidSettingsError(settingsPath, "invalid settings shape");
		await publishSettings(settingsPath, updated, options.signal, options.beforeRename);
		return settings;
	});
}

export async function awaitRoastModeSettingsWrites(
	settingsPath = roastModeSettingsPath(),
): Promise<void> {
	await mutationQueues.get(settingsPath);
}

function enqueueMutation<T>(settingsPath: string, mutation: () => Promise<T>): Promise<T> {
	const previous = mutationQueues.get(settingsPath) ?? Promise.resolve();
	const result = previous.then(mutation, mutation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	mutationQueues.set(settingsPath, settled);
	void settled.finally(() => {
		if (mutationQueues.get(settingsPath) === settled) mutationQueues.delete(settingsPath);
	});
	return result;
}

async function readSettingsDocumentForUpdate(
	settingsPath: string,
	legacySettingsPath: string | undefined,
): Promise<SettingsDocument> {
	const canonical = await readSettingsSnapshot(settingsPath);
	if (canonical.result.kind === "loaded") return canonical.document ?? {};
	if (canonical.result.kind === "invalid") {
		throw invalidSettingsError(settingsPath, canonical.result.reason);
	}
	if (!legacySettingsPath) return {};

	const legacy = await readSettingsSnapshot(legacySettingsPath);
	const raced = await readSettingsSnapshot(settingsPath);
	if (raced.result.kind === "loaded") return raced.document ?? {};
	if (raced.result.kind === "invalid") {
		throw invalidSettingsError(settingsPath, raced.result.reason);
	}
	if (legacy.result.kind === "invalid") {
		throw invalidSettingsError(legacySettingsPath, legacy.result.reason);
	}
	return legacy.document ?? {};
}

async function readSettingsSnapshot(settingsPath: string): Promise<SettingsSnapshot> {
	let contents: string;
	try {
		contents = await readSettingsContents(settingsPath);
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
		return { result: { kind: "invalid", reason: safeReadError(error) } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch {
		return { result: { kind: "invalid", reason: "invalid JSON" } };
	}
	const settings = normalizeRoastModeSettings(parsed);
	if (!settings || !isSettingsDocument(parsed)) {
		return { result: { kind: "invalid", reason: "invalid settings shape" } };
	}
	return { document: parsed, result: { kind: "loaded", settings } };
}

async function readSettingsContents(settingsPath: string): Promise<string> {
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(settingsPath, flags);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("settings path is not a regular file");
		if (stats.size > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				buffer.subarray(0, offset),
			);
		} catch {
			throw new Error("settings file is not valid UTF-8");
		}
	} finally {
		await handle.close();
	}
}

async function publishSettings(
	settingsPath: string,
	document: SettingsDocument,
	signal?: AbortSignal,
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>,
): Promise<void> {
	signal?.throwIfAborted();
	const contents = `${JSON.stringify(document, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) {
		throw new Error(`settings document exceeds ${MAX_SETTINGS_BYTES} bytes`);
	}
	const directory = dirname(settingsPath);
	await mkdir(directory, { recursive: true });
	signal?.throwIfAborted();
	const temporaryPath = join(
		directory,
		`.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, contents, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
			signal,
		});
		await beforeRename?.(temporaryPath, settingsPath);
		signal?.throwIfAborted();
		await rename(temporaryPath, settingsPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function isSettingsDocument(value: unknown): value is SettingsDocument {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string) {
	try {
		const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		await handle.close();
		return true;
	} catch (error: unknown) {
		return !(isNodeError(error) && error.code === "ENOENT");
	}
}

function invalidSettingsError(settingsPath: string, reason: string) {
	return new Error(`pi-roast-mode settings at ${settingsPath} are invalid: ${reason}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function safeReadError(error: unknown) {
	if (isNodeError(error) && error.code === "ELOOP") return "settings path is not a regular file";
	return error instanceof Error ? error.message : String(error);
}

export function configuredRoastStyle(settings: RoastModeSettings): RoastStyle {
	return settings.roastStyle ?? "mid";
}

export function configuredThinkingLevel(
	settings: RoastModeSettings,
): RoastModeFixedThinkingLevel | undefined {
	return settings.thinkingLevel === "inherit" ? undefined : settings.thinkingLevel;
}

export function configuredImplementationRoastRetention(
	settings: RoastModeSettings,
): ImplementationRoastRetention {
	return settings.implementationRoastRetention ?? "keep";
}

export function configuredRoastExportPath(settings: RoastModeSettings) {
	return settings.defaultRoastExportPath ?? DEFAULT_ROAST_EXPORT_PATH;
}

export function configuredRoastModeToggleShortcut(settings: RoastModeSettings): KeyId | undefined {
	return settings.toggleShortcut;
}
