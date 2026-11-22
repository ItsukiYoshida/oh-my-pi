import { afterEach, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import monitor from "../examples/extensions/monitor";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import * as exec from "../src/exec/exec";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ManagedTimers } from "../src/extensibility/extensions/managed-timers";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { initializeExtensions } from "../src/modes/runtime-init";
import { EventBus } from "../src/utils/event-bus";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface PullRequestFixture {
	url: string;
	state: string;
	headRefOid: string;
	reviews: object[];
	comments: object[];
	statusCheckRollup: object[];
}

function pullRequest(): PullRequestFixture {
	return {
		url: "https://github.com/acme/app/pull/7",
		state: "OPEN",
		headRefOid: "abc1234def",
		reviews: [],
		comments: [],
		statusCheckRollup: [{ name: "build", status: "IN_PROGRESS", conclusion: "" }],
	};
}

/**
 * `forkBranchPr`: the checkout is a fork (gh's default repo is upstream) whose branch has a PR in origin,
 * so only `gh pr view <branch> --repo <origin>` finds it.
 */
async function openSession(pr: PullRequestFixture, forkBranchPr: boolean) {
	const dir = TempDir.createSync("omp-monitor-");
	cleanups.push(() => dir.remove());
	vi.spyOn(exec, "execCommand").mockImplementation(async (command, args) => {
		const call = [command, ...args].join(" ");
		let stdout = "";
		if (call === "gh api user --jq .login") stdout = "me\n";
		else if (call === "git branch --show-current") stdout = "feature\n";
		else if (call === "git remote get-url origin") stdout = "git@github.com:acme/app.git\n";
		else if (call.startsWith("gh pr view 7 --repo acme/app ")) stdout = JSON.stringify(pr);
		else if (forkBranchPr && call.startsWith("gh pr view feature --repo acme/app ")) stdout = JSON.stringify(pr);
		return { stdout, stderr: stdout ? "" : "no pull requests found", code: stdout ? 0 : 1, killed: false };
	});
	// Drive polls directly instead of waiting out the 60s interval.
	const polls: (() => unknown)[] = [];
	const capture: ManagedTimers["setInterval"] = callback => {
		polls.push(callback);
		return setTimeout(() => {}, 0);
	};
	vi.spyOn(ManagedTimers.prototype, "setInterval").mockImplementation(capture);
	vi.spyOn(ManagedTimers.prototype, "setTimeout").mockImplementation(capture);

	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(monitor, dir.path(), new EventBus(), runtime);
	const auth = await AuthStorage.create(":memory:");
	cleanups.push(() => auth.close());
	const registry = new ModelRegistry(auth);
	const manager = SessionManager.inMemory(dir.path());
	const runner = new ExtensionRunner([extension], runtime, dir.path(), manager, registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing fixture model");
	const stream = vi.fn(createMockModel({ handler: () => ({ content: ["noted"] }) }).stream);
	const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [] }, streamFn: stream });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	cleanups.push(() => session.dispose());
	const sends: Promise<unknown>[] = [];
	await initializeExtensions(session, {
		reportSendError: error => {
			throw error;
		},
		reportRuntimeError: error => {
			throw new Error(error.error);
		},
		trackExtensionSend: task => sends.push(task),
	});
	const poll = async () => {
		await polls[0]?.();
		await Promise.all(sends.splice(0));
		await session.waitForIdle();
	};
	const events = () =>
		agent.state.messages.flatMap(message =>
			message.role === "custom" && message.customType === "monitor-event" && typeof message.content === "string"
				? [message.content]
				: [],
		);
	return { session, stream, poll, events };
}

test("the branch's PR is monitored without setup: others' activity wakes the agent once, its own comments never", async () => {
	const pr = pullRequest();
	const { stream, poll, events } = await openSession(pr, true);
	await poll(); // baseline
	await poll();
	expect(stream).not.toHaveBeenCalled();

	pr.reviews = [{ id: "R1", author: { login: "alice" }, state: "CHANGES_REQUESTED", body: "Please\nrename foo" }];
	pr.comments = [{ id: "C1", author: { login: "me" }, body: "Working on it", url: "https://x/c1" }];
	pr.statusCheckRollup = [{ name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/1" }];
	await poll();
	expect(stream).toHaveBeenCalledTimes(1);
	expect(events()).toHaveLength(1);
	expect(events()[0]).toContain('Review CHANGES_REQUESTED by @alice: "Please rename foo"');
	expect(events()[0]).toContain('Check "build" FAILURE on abc1234: https://ci/1');
	expect(events()[0]).not.toContain("Working on it");

	await poll();
	expect(stream).toHaveBeenCalledTimes(1);
});

test("/monitor watches a PR outside the current branch and reports its merge", async () => {
	const pr = pullRequest();
	const { session, stream, poll, events } = await openSession(pr, false);
	await session.prompt("/monitor https://github.com/acme/app/pull/7");
	await poll();
	expect(stream).not.toHaveBeenCalled();

	pr.state = "MERGED";
	await poll();
	expect(stream).toHaveBeenCalledTimes(1);
	expect(events()[0]).toContain("PR is now MERGED");
});
