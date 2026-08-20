import assert from "node:assert/strict";
import { test } from "vitest";
import roastMode from "../src/roast-mode.js";
import { createMockContext, createMockPi } from "./support.js";

test("issue 302: re-entered Roast Mode hides the previous implementation handoff", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
	roastMode(mock.pi);
	const context = createMockContext();

	await mock.commands.get("roast")?.handler("start", context.ctx);
	const executeComplete = mock.tools.find((candidate) => candidate.name === "roast_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(executeComplete);
	await executeComplete(
		"complete",
		{ roast: "# Roast Mode repro" },
		undefined,
		undefined,
		context.ctx,
	);

	await mock.commands.get("roast")?.handler("implement", context.ctx);
	const implementationHandoff = mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(implementationHandoff, /Roast mode is now disabled/);
	assert.match(implementationHandoff, /Implement this proposed roast now/);
	assert.equal(context.statuses.get("roast-mode"), "roast implementing");

	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const implementationMessages = [
		{ role: "user", content: "Roast a one-line README change." },
		{ role: "user", content: implementationHandoff },
		{ role: "assistant", content: "Implemented the requested roast." },
	];
	const inactiveContext = (await contextHook(
		{ messages: implementationMessages },
		context.ctx,
	)) as { messages: unknown[] };
	assert.deepEqual(inactiveContext.messages, implementationMessages);

	await mock.commands.get("roast")?.handler("start", context.ctx);
	assert.equal(context.statuses.get("roast-mode"), "roast active");
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"roast_mode_question",
		"roast_mode_complete",
	]);

	const beforeStart = mock.events.get("before_agent_start")?.[0];
	assert.ok(beforeStart);
	const promptResult = beforeStart({ systemPrompt: "base" }, context.ctx) as {
		systemPrompt?: string;
	};
	assert.match(promptResult.systemPrompt ?? "", /You are in Roast Mode/);
	assert.match(promptResult.systemPrompt ?? "", /roast_mode_complete/);

	const activeMessages = [...implementationMessages, { role: "user", content: "continue" }];
	const activeContext = (await contextHook({ messages: activeMessages }, context.ctx)) as {
		messages: unknown[];
	};

	assert.deepEqual(activeContext.messages, [
		implementationMessages[0],
		implementationMessages[2],
		activeMessages[3],
	]);
	assert.doesNotMatch(
		JSON.stringify(activeContext.messages),
		/Roast mode is now disabled\. Full tool access is restored/,
	);
});
