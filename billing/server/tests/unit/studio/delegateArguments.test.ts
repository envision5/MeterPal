// The delegate_to repair, tested against the schema shape AG Studio really
// publishes for the tool.
//
// Why this test exists: `delegate_to` is executed client-side by Studio, so a
// malformed call fails where this server cannot observe it -- the agent loop
// just shows "Delegated to ... Failed" and stops. These cases pin the repair
// to the two shapes that actually reach it, and pin it to *not* touching
// anything it cannot confirm.

import { describe, expect, test } from "bun:test";
import {
	openAiCompletionToStudioResponse,
	type StudioToolSchema,
} from "@/internal/studio/llmProtocol.js";

/** The tool as Studio sends it: `type` is a union of `{ id, ...params }`. */
const delegateTool: StudioToolSchema = {
	name: "delegate_to",
	description: "Delegate a subtask to a specialised sub-agent.",
	parameters: {
		type: "object",
		properties: {
			type: {
				anyOf: [
					{
						type: "object",
						properties: { id: { type: "string", enum: ["data"] } },
						required: ["id"],
					},
					{
						type: "object",
						properties: {
							id: { type: "string", enum: ["widget"] },
							widgetType: { type: "string" },
							widgetId: { type: "string" },
							pageId: { type: "string" },
						},
						required: ["id"],
					},
					{
						type: "object",
						properties: {
							id: { type: "string", enum: ["page"] },
							pageId: { type: "string" },
						},
						required: ["id"],
					},
					{
						type: "object",
						properties: { id: { type: "string", enum: ["planning"] } },
						required: ["id"],
					},
				],
			},
			instructions: { type: "string" },
		},
		required: ["type", "instructions"],
		additionalProperties: false,
	},
};

/** Run one model turn through the converter and read the call it produced. */
const convert = ({
	args,
	tools = [delegateTool],
}: {
	args: string;
	tools?: StudioToolSchema[];
}) => {
	const response = openAiCompletionToStudioResponse({
		fallbackId: "resp_1",
		tools,
		completion: {
			id: "resp_1",
			choices: [
				{
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "delegate_to", arguments: args },
							},
						],
					},
				},
			],
		},
	});

	const item = response.output.find((entry) => entry.type === "function_call");
	if (item?.type !== "function_call") throw new Error("no function_call emitted");
	return JSON.parse(item.arguments) as Record<string, unknown>;
};

describe("delegate_to argument repair", () => {
	test("wraps a flattened target id the schema offers", () => {
		const args = convert({
			args: JSON.stringify({
				type: "page",
				instructions: "Place a chart of credits over the last 4 days.",
			}),
		});

		expect(args.type).toEqual({ id: "page" });
		expect(args.instructions).toBe(
			"Place a chart of credits over the last 4 days.",
		);
	});

	test("moves the target's own params inside the discriminant", () => {
		// What the model emits when it decides on a widget: the id flat, and
		// the widget's params beside it.
		const args = convert({
			args: JSON.stringify({
				type: "widget",
				widgetId: "spend-over-time",
				widgetType: "line-chart",
				pageId: "usage",
				instructions: "Switch this chart to the last 4 days.",
			}),
		});

		expect(args.type).toEqual({
			id: "widget",
			widgetId: "spend-over-time",
			widgetType: "line-chart",
			pageId: "usage",
		});
		expect(args.instructions).toBe("Switch this chart to the last 4 days.");
	});

	test("folds params left outside an already-nested discriminant", () => {
		const args = convert({
			args: JSON.stringify({
				type: { id: "widget" },
				widgetType: "line-chart",
				instructions: "Add a chart.",
			}),
		});

		expect(args.type).toEqual({ id: "widget", widgetType: "line-chart" });
	});

	test("leaves an already-correct call byte-identical", () => {
		const raw = JSON.stringify({
			type: { id: "data", pageId: "usage" },
			instructions: "How many credits were spent yesterday?",
		});
		expect(JSON.stringify(convert({ args: raw }))).toBe(
			JSON.stringify(JSON.parse(raw)),
		);
	});

	test("does not invent a target the schema never offered", () => {
		// A hallucinated agent id must still fail loudly in Studio rather than
		// be rewritten into something plausible here.
		const args = convert({
			args: JSON.stringify({ type: "sales", instructions: "Do the thing." }),
		});
		expect(args.type).toBe("sales");
	});

	test("leaves a call alone when the schema is not supplied", () => {
		const args = convert({
			args: JSON.stringify({ type: "page", instructions: "Place a chart." }),
			tools: [],
		});
		expect(args.type).toBe("page");
	});

	test("does not rewrite other tools", () => {
		const response = openAiCompletionToStudioResponse({
			fallbackId: "resp_2",
			tools: [delegateTool],
			completion: {
				id: "resp_2",
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_2",
									type: "function",
									function: {
										name: "view_page",
										arguments: JSON.stringify({ type: "page" }),
									},
								},
							],
						},
					},
				],
			},
		});

		const item = response.output.find((e) => e.type === "function_call");
		if (item?.type !== "function_call") throw new Error("no function_call");
		expect(JSON.parse(item.arguments)).toEqual({ type: "page" });
	});

	test("survives arguments that are not JSON", () => {
		// A model that truncates its own arguments must reach Studio as it
		// wrote them -- a parse failure here would turn a bad call into a 500.
		const response = openAiCompletionToStudioResponse({
			fallbackId: "resp_3",
			tools: [delegateTool],
			completion: {
				id: "resp_3",
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_3",
									type: "function",
									function: { name: "delegate_to", arguments: "{not json" },
								},
							],
						},
					},
				],
			},
		});

		const item = response.output.find((e) => e.type === "function_call");
		if (item?.type !== "function_call") throw new Error("no function_call");
		expect(item.arguments).toBe("{not json");
	});
});

/**
 * The second repair: nested arguments the model sent as JSON strings.
 *
 * `add_widget_filter` takes a `field`, a `model` condition and a `view`, all
 * objects. The model emits each as a JSON string, the tool rejects it, and the
 * loop retries the same call until it runs out of turns -- which is exactly the
 * "agentic loop does nothing" symptom.
 */
const filterTool: StudioToolSchema = {
	name: "add_widget_filter",
	description: "Add a single widget-level filter.",
	parameters: {
		type: "object",
		properties: {
			widgetId: { type: "string" },
			op: { type: "string", enum: ["append", "replace"] },
			field: { type: "object" },
			model: { type: "object" },
			view: { type: "object" },
		},
		required: ["widgetId", "field"],
		additionalProperties: false,
	},
};

const convertCall = ({
	name,
	args,
	tools,
}: {
	name: string;
	args: string;
	tools: StudioToolSchema[];
}) => {
	const response = openAiCompletionToStudioResponse({
		fallbackId: "resp_f",
		tools,
		completion: {
			id: "resp_f",
			choices: [
				{
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{ id: "call_f", type: "function", function: { name, arguments: args } },
						],
					},
				},
			],
		},
	});

	const item = response.output.find((e) => e.type === "function_call");
	if (item?.type !== "function_call") throw new Error("no function_call");
	return JSON.parse(item.arguments) as Record<string, unknown>;
};

describe("nested argument repair", () => {
	test("parses JSON-stringified objects the schema wants as objects", () => {
		const args = convertCall({
			name: "add_widget_filter",
			tools: [filterTool],
			args: JSON.stringify({
				widgetId: "spend-over-time",
				op: "append",
				field: JSON.stringify({ id: "usage.period" }),
				model: JSON.stringify({
					operator: "inRelativeRange",
					value: { type: "last", unit: "day", value: 4, includeToday: true },
				}),
				view: JSON.stringify({ viewTypeId: "relativeDate", expanded: false }),
			}),
		});

		expect(args.field).toEqual({ id: "usage.period" });
		expect(args.model).toEqual({
			operator: "inRelativeRange",
			value: { type: "last", unit: "day", value: 4, includeToday: true },
		});
		expect(args.view).toEqual({ viewTypeId: "relativeDate", expanded: false });
	});

	test("leaves a string alone when the schema wants a string", () => {
		// `widgetId` is a string. Even a value that looks like JSON must stay a
		// string -- the repair reads the schema, it does not guess from content.
		const args = convertCall({
			name: "add_widget_filter",
			tools: [filterTool],
			args: JSON.stringify({
				widgetId: '{"looks":"like json"}',
				field: JSON.stringify({ id: "usage.period" }),
			}),
		});

		expect(args.widgetId).toBe('{"looks":"like json"}');
	});

	test("leaves an unparseable string in a structured slot untouched", () => {
		const args = convertCall({
			name: "add_widget_filter",
			tools: [filterTool],
			args: JSON.stringify({ widgetId: "w", field: "usage.period" }),
		});

		expect(args.field).toBe("usage.period");
	});

	test("repairs inside a union of objects", () => {
		// delegate_to's `type` is an anyOf of objects; the same repair has to
		// reach a stringified branch before the discriminant repair runs.
		const args = convertCall({
			name: "delegate_to",
			tools: [delegateTool],
			args: JSON.stringify({
				type: JSON.stringify({ id: "widget", widgetType: "line-chart" }),
				instructions: "Add the chart.",
			}),
		});

		expect(args.type).toEqual({ id: "widget", widgetType: "line-chart" });
	});
});
