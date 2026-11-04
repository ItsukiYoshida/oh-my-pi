import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import ldevDescription from "../prompts/tools/ldev.md" with { type: "text" };
import { formatLdevResult, ldev } from "../utils/ldev";
import type { ToolSession } from ".";

const ldevSchema = type({
	args: type("string[]").describe('ldev arguments without the leading "ldev", e.g. ["lane", "status"]'),
});

export class LdevTool implements AgentTool<typeof ldevSchema> {
	readonly name = "ldev";
	readonly label = "ldev";
	readonly summary = "Manage ldev issue worktrees, lanes, leases, deploys, and endpoint URLs";
	readonly description = ldevDescription;
	readonly parameters = ldevSchema;
	readonly approval = "exec" as const;
	readonly loadMode = "discoverable" as const;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LdevTool | null {
		return ldev.available() ? new LdevTool(session) : null;
	}

	async execute(_id: string, params: typeof ldevSchema.infer, signal?: AbortSignal): Promise<AgentToolResult> {
		const result = await ldev.run(this.session.cwd, params.args, signal);
		return {
			content: [{ type: "text", text: formatLdevResult(params.args, result) }],
			...(result.exitCode === 0 ? {} : { isError: true }),
		};
	}
}
