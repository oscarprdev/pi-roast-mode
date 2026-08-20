import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ROAST_MODE_QUESTION_TOOL_NAME = "roast_mode_question";

export type RoastModeQuestionOption = {
	label: string;
	description?: string;
};

export type RoastModeQuestion = {
	id: string;
	header: string;
	question: string;
	options: RoastModeQuestionOption[];
};

type RoastModeQuestionAnswer = {
	id: string;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
};

type RoastModeQuestionReason =
	| "cancelled"
	| "ui_unavailable"
	| "roast_mode_inactive"
	| "invalid_input";

type RoastModeQuestionDetails = {
	cancelled: boolean;
	reason?: RoastModeQuestionReason;
	questions: RoastModeQuestion[];
	answers?: RoastModeQuestionAnswer[];
};

export const ROAST_MODE_QUESTION_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			description: "Questions to show the user. Prefer 1 and do not exceed 3.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "header", "question", "options"],
				properties: {
					id: {
						type: "string",
						description: "Stable identifier for mapping answers (snake_case).",
					},
					header: {
						type: "string",
						description: "Short header label shown in the UI (12 or fewer chars).",
					},
					question: { type: "string", description: "Single-sentence prompt shown to the user." },
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						description:
							"Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["label", "description"],
							properties: {
								label: { type: "string", description: "User-facing label (1-5 words)." },
								description: {
									type: "string",
									description: "One short sentence explaining impact/tradeoff if selected.",
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

type NormalizeRoastModeQuestionParamsResult =
	| { ok: true; questions: RoastModeQuestion[] }
	| { ok: false; error: string };

export function normalizeRoastModeQuestionParams(
	input: unknown,
): NormalizeRoastModeQuestionParamsResult {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false, error: "questions must contain 1-3 items" };
	}

	const questions: RoastModeQuestion[] = [];
	for (const [questionIndex, rawQuestion] of input.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			return { ok: false, error: `question ${questionIndex + 1} must be an object` };
		}
		const id = stringField(rawQuestion.id);
		const header = stringField(rawQuestion.header);
		const question = stringField(rawQuestion.question);
		if (!id || !header || !question) {
			return {
				ok: false,
				error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
			};
		}
		if (!Array.isArray(rawQuestion.options)) {
			return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
		}
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
		}
		const options: RoastModeQuestionOption[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
			if (!isRecord(rawOption)) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
				};
			}
			const label = stringField(rawOption.label);
			if (!label) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
				};
			}
			const description = stringField(rawOption.description);
			if (!description) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
				};
			}
			options.push({ label, description });
		}
		questions.push({ id, header, question, options });
	}
	return { ok: true, questions };
}

export async function answerRoastModeQuestions(
	questions: RoastModeQuestion[],
	ctx: ExtensionContext,
	lifecycle: { isCurrent(): boolean; isEnabled(): boolean },
) {
	const answers = await askRoastModeQuestions(
		questions,
		ctx,
		() => lifecycle.isCurrent() && lifecycle.isEnabled(),
	);
	if (!lifecycle.isCurrent()) {
		return roastModeQuestionCancelled(
			questions,
			"cancelled",
			"Roast-mode question cancelled because the session changed.",
		);
	}
	if (!lifecycle.isEnabled()) {
		return roastModeQuestionCancelled(
			questions,
			"roast_mode_inactive",
			"Roast-mode question cancelled because Roast mode is no longer active.",
		);
	}
	if (!answers) {
		return roastModeQuestionCancelled(
			questions,
			"cancelled",
			"User cancelled the Roast-mode question prompt.",
		);
	}
	return roastModeQuestionAnswered(questions, answers);
}

export async function askRoastModeQuestions(
	questions: RoastModeQuestion[],
	ctx: ExtensionContext,
	shouldContinue: () => boolean = () => true,
): Promise<RoastModeQuestionAnswer[] | undefined> {
	const answers: RoastModeQuestionAnswer[] = [];
	for (const question of questions) {
		const choices = question.options.map(formatRoastModeQuestionChoice);
		const otherChoice = `${question.options.length + 1}. Other (free-form)`;
		const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [
			...choices,
			otherChoice,
		]);
		if (!shouldContinue() || !choice) return undefined;
		if (choice === otherChoice) {
			const customAnswer = (await ctx.ui.editor(question.question, ""))?.trim();
			if (!shouldContinue() || !customAnswer) return undefined;
			answers.push({
				id: question.id,
				header: question.header,
				question: question.question,
				answer: customAnswer,
				wasCustom: true,
			});
			continue;
		}
		const optionIndex = choices.indexOf(choice);
		const option = question.options[optionIndex];
		if (!option) return undefined;
		answers.push({
			id: question.id,
			header: question.header,
			question: question.question,
			answer: option.label,
			wasCustom: false,
			optionIndex: optionIndex + 1,
		});
	}
	return answers;
}

function formatRoastModeQuestionChoice(option: RoastModeQuestionOption, index: number) {
	return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

export function roastModeQuestionAnswered(
	questions: RoastModeQuestion[],
	answers: RoastModeQuestionAnswer[],
) {
	return {
		content: [
			{
				type: "text" as const,
				text: formatRoastModeQuestionPayload({ cancelled: false, answers }),
			},
		],
		details: { cancelled: false, questions, answers } satisfies RoastModeQuestionDetails,
	};
}

export function roastModeQuestionCancelled(
	questions: RoastModeQuestion[],
	reason: RoastModeQuestionReason,
	message: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: formatRoastModeQuestionPayload({ cancelled: true, reason, message }),
			},
		],
		details: { cancelled: true, reason, questions } satisfies RoastModeQuestionDetails,
	};
}

function formatRoastModeQuestionPayload(payload: {
	cancelled: boolean;
	reason?: RoastModeQuestionReason;
	message?: string;
	answers?: RoastModeQuestionAnswer[];
}) {
	return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
	return typeof value === "string" ? value.trim() : undefined;
}
