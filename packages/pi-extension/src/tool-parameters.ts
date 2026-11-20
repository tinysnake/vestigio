import { Type } from "typebox";
import { MAX_CARD_LIMIT } from "@vestigio/core/retrieval";
import { MAX_REQUEST_EVIDENCE, MAX_REQUEST_INTENT_CHARS } from "./request-consent.js";

export const searchParameters = Type.Object({
	query: Type.String({
		description:
			"Hotspot keywords or a short phrase to look up in the local memory store. Exact words work best.",
	}),
	include_archived: Type.Optional(
		Type.Boolean({ description: "Also search archived memories (default false)." }),
	),
	include_history: Type.Optional(
		Type.Boolean({
			description:
				"Also search the read-only session history layer. Requires the host to be configured with a history source.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum number of memory cards (1-${MAX_CARD_LIMIT}, default 5).`,
			minimum: 1,
			maximum: MAX_CARD_LIMIT,
		}),
	),
});

export const readParameters = Type.Object({
	uri: Type.String({
		description: "A memory URI of the form memory://<store-id>/<memory-id>, as returned by memory_search.",
	}),
	revision: Type.Optional(
		Type.Integer({ description: "Read a specific revision instead of the current one.", minimum: 1 }),
	),
});

export const resolveParameters = Type.Object({
	question: Type.String({
		description:
			"A question in natural language. The resolver gathers zero-LLM candidates, then asks the configured model to judge them, expand the query and descend through Active, Archived and the raw history layer.",
	}),
	include_history: Type.Optional(
		Type.Boolean({
			description:
				"Search the read-only history layer when the stored memories are not sufficient (default true).",
		}),
	),
});

export const markStaleParameters = Type.Object({
	uri: Type.String({
		description: "A memory URI of the form memory://<store-id>/<memory-id>, as returned by memory_search.",
	}),
	observed_revision: Type.Integer({
		minimum: 1,
		description: "The revision of the summary you actually read (the delivered revision).",
	}),
	reason: Type.String({
		description: "One short sentence naming the change this summary has not absorbed yet.",
	}),
	excerpt: Type.String({
		description:
			"The later evidence text. It is bounded and stored next to the event so the warning survives even when history indexing lags.",
	}),
	source_message_ids: Type.Optional(Type.Array(Type.String(), {
		description: "Optional real entry ids from the active branch. If omitted, excerpt must quote a user/tool message verbatim so the tool can locate it.",
	})),
});

export const writeParameters = Type.Object({
	intent: Type.String({
		minLength: 1,
		maxLength: MAX_REQUEST_INTENT_CHARS,
		description:
			"The durable fact, decision, convention or scoped exception to remember, stated fully enough to stand alone. Do not write it for a session-only preference.",
	}),
	source_message_ids: Type.Optional(Type.Array(Type.String(), {
		maxItems: MAX_REQUEST_EVIDENCE,
		description:
			"Real entry ids from the active branch that support the intent. Use ids you saw in the conversation, never invented ones.",
	})),
	quotes: Type.Optional(Type.Array(Type.String(), {
		maxItems: MAX_REQUEST_EVIDENCE,
		description:
			"Exact excerpts from the operator's own messages in the active branch, when ids are not available. Each quote is located only in user messages; a quote from an assistant or tool entry fails the request.",
	})),
	scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], {
		description:
			"Requested scope. Omit for the project. Use global only when the operator's own words cover more than this project.",
	})),
});

export const statusParameters = Type.Object({
	request_id: Type.Optional(Type.String({ description: "A request id returned by memory_request_write." })),
	uri: Type.Optional(Type.String({ description: "The memory URI, once saved or merged." })),
});
