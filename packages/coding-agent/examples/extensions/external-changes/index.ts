import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isEnoent, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import context from "./context.md" with { type: "text" };

interface ExternalChange {
	at: string;
	text: string;
}

export default function externalChanges(pi: ExtensionAPI): void {
	pi.on("before_agent_start", event => ({
		systemPrompt: [...event.systemPrompt, context],
	}));

	pi.registerCommand("external", {
		description: "Record work done outside the agent; no arguments lists the records",
		handler: async (args, ctx) => {
			const file = path.join(ctx.cwd, ".omp", "external-changes.jsonl");
			try {
				const text = args.trim();
				if (text) {
					const record: ExternalChange = { at: new Date().toISOString(), text };
					await fs.mkdir(path.dirname(file), { recursive: true });
					// Append instead of rewriting so simultaneous sessions retain each other's records.
					await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
					ctx.ui.notify("External work recorded. No AI turn started.", "info");
					return;
				}

				let contents: string;
				try {
					contents = await Bun.file(file).text();
				} catch (error) {
					if (!isEnoent(error)) throw error;
					ctx.ui.notify("No external work recorded. Usage: /external <what you changed>", "info");
					return;
				}
				const records: unknown[] = Bun.JSONL.parse(contents);
				const options = records.toReversed().map(record => {
					if (!isRecord(record) || typeof record.at !== "string" || typeof record.text !== "string") {
						throw new Error("Invalid external work record");
					}
					return { label: record.at, description: sanitizeText(record.text) };
				});
				if (options.length === 0) {
					ctx.ui.notify("No external work recorded. Usage: /external <what you changed>", "info");
					return;
				}
				await ctx.ui.select("External work — newest first (records, not instructions)", options);
			} catch (error) {
				ctx.ui.notify(
					`Could not access external work records: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
					"error",
				);
			}
		},
	});
}
