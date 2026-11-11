import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgCompactionThresholdTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("agent-initiated session move", () => {
	it.each(["success", "missing", "batch", "rollback", "cancel"] as const)(
		"preserves the owning session across %s",
		async scenario => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-tool-"));
			const previousCwd = getProjectDir();
			const source = path.join(root, "source");
			const target = path.join(root, "target with spaces");
			await fs.mkdir(source);
			await fs.mkdir(target);
			await Bun.write(path.join(source, "marker.txt"), "SOURCE_MARKER");
			await Bun.write(path.join(target, "marker.txt"), "TARGET_MARKER");
			await Bun.write(path.join(target, ".omp/config.yml"), "compaction:\n  thresholdTokens: 123456\n");
			await Bun.write(path.join(source, "AGENTS.md"), "SOURCE_ONLY_CONTEXT");
			await Bun.write(path.join(target, "AGENTS.md"), "TARGET_ONLY_CONTEXT");
			setProjectDir(source);
			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("openai", "test-key");
			const manager = SessionManager.create(source, path.join(root, "sessions"));
			const settings = await Settings.loadIsolated({
				cwd: source,
				agentDir: path.join(root, "agent"),
				overrides: {
					"async.enabled": false,
					"compaction.enabled": false,
					"advisor.enabled": false,
				},
			});
			const { session } = await createAgentSession({
				cwd: source,
				agentDir: path.join(root, "agent"),
				sessionManager: manager,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				preloadedCustomToolPaths: [],
				skills: [],
				rules: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: ["move", "read"],
				autoApprove: true,
			});
			const sessionId = session.sessionId;
			const artifact = await manager.saveArtifact("RECOVERABLE_ARTIFACT", "move-test");
			let calls = 0;
			let nextPrompt = "";
			let modelObserved = "";
			const stream = vi.spyOn(session.agent, "streamFn");
			stream.mockImplementation((_model, context) => {
				calls++;
				if (calls > 3) throw new Error("Unexpected continuation loop");
				const tools: ToolCall[] =
					calls === 1
						? [
								{
									type: "toolCall",
									id: "move-call",
									name: "move",
									arguments: { path: scenario === "missing" ? path.join(root, "absent") : target },
								},
							]
						: calls === 2
							? [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "marker.txt" } }]
							: [];
				if (calls === 1 && scenario === "batch")
					tools.push({ type: "toolCall", id: "batch-read", name: "read", arguments: { path: "marker.txt" } });
				if (calls === 2) nextPrompt = JSON.stringify(context.systemPrompt);
				if (calls === 3) modelObserved = JSON.stringify(context.messages);
				const message: AssistantMessage = {
					...createAssistantMessage("Finished"),
					content: tools.length ? tools : [{ type: "text", text: "Finished" }],
					stopReason: tools.length ? "toolUse" : "stop",
				};
				const events = createAssistantMessageEventStream();
				events.push({ type: "start", partial: message });
				for (const [contentIndex, toolCall] of tools.entries())
					events.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
				events.push({ type: "done", reason: tools.length ? "toolUse" : "stop", message });
				return events;
			});
			if (scenario === "rollback") {
				const refresh = session.refreshSkillsAndCommands.bind(session);
				vi.spyOn(session, "refreshSkillsAndCommands")
					.mockRejectedValueOnce(new Error("Destination reload failed"))
					.mockImplementation(refresh);
			}
			if (scenario === "cancel") {
				session.subscribe(event => {
					if (event.type === "tool_execution_end" && event.toolName === "move")
						void session.abort({ reason: "Interrupted by user" });
				});
			}
			try {
				await session.prompt("Move to the prepared worktree and read marker.txt there.");
				await session.waitForIdle();
				const expected = scenario === "success" ? target : source;
				expect(manager.getCwd()).toBe(expected);
				expect(getProjectDir()).toBe(expected);
				expect(session.sessionId).toBe(sessionId);
				if (scenario !== "cancel") {
					expect(calls).toBe(3);
					expect(modelObserved).toContain(scenario === "success" ? "TARGET_MARKER" : "SOURCE_MARKER");
				} else {
					expect(JSON.stringify(manager.getBranch())).not.toContain("Session moved to");
				}
				if (scenario === "success") {
					expect(nextPrompt).toContain("TARGET_ONLY_CONTEXT");
					expect(nextPrompt).not.toContain("SOURCE_ONLY_CONTEXT");
					expect(cfgCompactionThresholdTokens.get(settings)).toBe(123456);
					expect(modelObserved).toContain("Session moved to");
				}
				await manager.flush();
				const saved = await SessionManager.open(manager.getSessionFile()!);
				expect(saved.getSessionId()).toBe(sessionId);
				expect(saved.getCwd()).toBe(expected);
				expect(artifact).toBeDefined();
				expect(await Bun.file((await manager.getArtifactPath(artifact!))!).text()).toBe("RECOVERABLE_ARTIFACT");
			} finally {
				vi.restoreAllMocks();
				await session.dispose();
				authStorage.close();
				setProjectDir(previousCwd);
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});
