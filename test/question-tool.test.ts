import assert from "node:assert/strict";
import { test } from "vitest";
import roastMode, { normalizeRoastModeQuestionParams } from "../src/roast-mode.js";
import { createMockContext, createMockPi } from "./support.js";

test("roast_mode_question reports non-interactive cancellation", async () => {
	const mock = createMockPi();
	roastMode(mock.pi);
	const execute = mock.tools[0]?.execute as
		| ((...args: unknown[]) => Promise<{ details?: { reason?: string } }>)
		| undefined;
	assert.ok(execute);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("roast")?.handler("start", context.ctx);
	const result = await execute(
		"call-1",
		{
			questions: [
				{
					id: "scope",
					header: "Scope",
					question: "How broad?",
					options: [
						{ label: "Small", description: "Only the bug." },
						{ label: "Broad", description: "Include cleanup." },
					],
				},
			],
		},
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(result.details?.reason, "ui_unavailable");
});

test("normalizeRoastModeQuestionParams validates question shape", () => {
	const result = normalizeRoastModeQuestionParams({
		questions: [
			{
				id: "scope",
				header: "Scope",
				question: "How broad?",
				options: [
					{ label: "Small", description: "Only the bug." },
					{ label: "Broad", description: "Include nearby cleanup." },
				],
			},
		],
	});

	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
	assert.deepEqual(normalizeRoastModeQuestionParams({ questions: [] }), {
		ok: false,
		error: "questions must contain 1-3 items",
	});
});
