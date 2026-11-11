import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import moveDescription from "../prompts/tools/move.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { throwIfAborted } from "./tool-errors";

const moveSchema = type({ path: type("string").describe("Absolute path of an existing local working directory") });

export class MoveTool implements AgentTool<typeof moveSchema> {
	readonly name = "move";
	readonly label = "Move Session";
	readonly description = moveDescription;
	readonly parameters = moveSchema;
	readonly approval = "exec" as const;
	readonly concurrency = "exclusive" as const;
	readonly loadMode = "essential" as const;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MoveTool | null {
		return session.requestSessionMove && (session.taskDepth ?? 0) === 0 && !session.requireYieldTool
			? new MoveTool(session)
			: null;
	}

	async execute(id: string, params: typeof moveSchema.infer, signal?: AbortSignal): Promise<AgentToolResult> {
		throwIfAborted(signal);
		if (!this.session.requestSessionMove) throw new ToolError("Session move is unavailable.");
		await this.session.requestSessionMove(id, params.path, signal);
		return {
			content: [
				{
					type: "text",
					text: "Session move requested. The owning session will report the result before the next model request.",
				},
			],
		};
	}
}
