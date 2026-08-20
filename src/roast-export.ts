import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ROAST_EXPORT_PATH } from "./settings.js";
import type { RoastModeState } from "./state.js";

export { DEFAULT_ROAST_EXPORT_PATH };

export interface RoastExportResult {
	path: string;
}

export interface RoastExportDestination {
	configuredPath: string;
	resolvedPath: string;
}

export interface RoastExportLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
	getState?(): RoastModeState;
	finishReady?(): void;
}

export async function exportStoredRoast(
	state: RoastModeState,
	requestedPath: string | undefined,
	ctx: ExtensionContext,
	lifecycle?: RoastExportLifecycle,
	defaultPath = DEFAULT_ROAST_EXPORT_PATH,
) {
	const roast =
		(state.enabled ? state.latestRoast : undefined)?.trim() ??
		state.savedRoast?.roast.trim() ??
		state.activeImplementation?.roast.trim();
	if (!roast) {
		const error = new Error(
			"No completed roast is available to export. Use /roast finalize when roasting is complete.",
		);
		if (!ctx.hasUI) throw error;
		ctx.ui.notify(error.message, "warning");
		return false;
	}

	const isCurrent = () =>
		!lifecycle ||
		(lifecycle.isCurrent() && (!lifecycle.getState || lifecycle.getState() === state));
	let result: RoastExportResult;
	try {
		result = await exportRoastToFile(
			roast,
			requestedPath,
			ctx.cwd,
			lifecycle?.signal,
			isCurrent,
			defaultPath,
		);
	} catch (error: unknown) {
		if (lifecycle?.signal.aborted || !isCurrent()) return false;
		if (!ctx.hasUI) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(safeNotification(`Unable to export roast: ${detail}`), "error");
		return false;
	}

	if (!isCurrent()) return false;
	const finishedReady =
		state.enabled && Boolean(state.latestRoast?.trim()) && lifecycle?.finishReady !== undefined;
	if (finishedReady) lifecycle.finishReady?.();
	const detail = finishedReady ? " Roast mode disabled." : "";
	ctx.ui.notify(safeNotification(`Roast exported to ${result.path}.${detail}`), "info");
	return true;
}

export async function exportRoastToFile(
	roast: string,
	requestedPath: string | undefined,
	cwd: string,
	signal?: AbortSignal,
	isCurrent: () => boolean = () => true,
	defaultPath = DEFAULT_ROAST_EXPORT_PATH,
): Promise<RoastExportResult> {
	const path = resolveRoastExportPath(requestedPath, cwd, defaultPath);
	await withFileMutationQueue(path, async () => {
		throwIfCancelled(signal, isCurrent);
		await mkdir(dirname(path), { recursive: true });
		throwIfCancelled(signal, isCurrent);
		try {
			await writeFile(path, `${roast}\n`, { encoding: "utf8", flag: "wx" });
		} catch (error: unknown) {
			if (isNodeError(error) && error.code === "EEXIST") {
				throw new Error(
					`Roast export target already exists: ${path}. Choose another path or remove it first.`,
				);
			}
			throw error;
		}
	});
	return { path };
}

export function roastExportDestination(defaultPath: string, cwd: string): RoastExportDestination {
	return {
		configuredPath: safeNotification(defaultPath),
		resolvedPath: safeNotification(resolveRoastExportPath(undefined, cwd, defaultPath)),
	};
}

export function resolveRoastExportPath(
	requestedPath: string | undefined,
	cwd: string,
	defaultPath = DEFAULT_ROAST_EXPORT_PATH,
) {
	const rawPath = requestedPath?.trim() || defaultPath;
	const normalizedPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (!normalizedPath.trim()) throw new Error("Roast export path must not be empty.");
	if (normalizedPath.includes("\0")) {
		throw new Error("Roast export path must not contain NUL bytes.");
	}
	return resolve(cwd, normalizedPath);
}

function safeNotification(value: string) {
	let sanitized = "";
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0);
		sanitized +=
			codePoint !== undefined && codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f)
				? character
				: " ";
	}
	return sanitized;
}

function throwIfCancelled(signal: AbortSignal | undefined, isCurrent: () => boolean) {
	if (!signal?.aborted && isCurrent()) return;
	throw signal?.reason instanceof Error
		? signal.reason
		: new DOMException("Roast export cancelled", "AbortError");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
