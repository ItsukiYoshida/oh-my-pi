import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isRecord, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import context from "./context.md" with { type: "text" };
import eventTemplate from "./event.md" with { type: "text" };
import loginTemplate from "./login.md" with { type: "text" };
import { type LoginState, readLogins, renewedLogins } from "./logins";

const POLL_MS = 60_000;
const LOGIN_POLL_MS = 10_000;
const AUTO = "auto";
const STATE_ENTRY = "monitor-targets";
const PR_FIELDS = "url,state,headRefOid,baseRefName,mergeable,reviews,comments,statusCheckRollup";
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

interface Change {
	key: string;
	text: string;
}

interface Snapshot {
	subject: string;
	changes: Change[];
}

interface Watch {
	/** `auto` (current branch PR), `owner/repo#N`, or `owner/repo`. */
	target: string;
	subject?: string;
	seen?: Set<string>;
}

interface Author {
	login?: string;
}

interface PullRequest {
	url: string;
	state: string;
	headRefOid: string;
	baseRefName: string;
	/** `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while GitHub recomputes it (e.g. right after the base moved). */
	mergeable: string;
	reviews: { id: string; author?: Author; state: string; body: string }[];
	comments: { id: string; author?: Author; body: string; url: string }[];
	statusCheckRollup: {
		name?: string;
		context?: string;
		conclusion?: string;
		state?: string;
		detailsUrl?: string;
		targetUrl?: string;
	}[];
}

interface RepoEvent {
	id: string;
	type: string;
	actor?: Author;
	payload?: { action?: string; ref?: string; pull_request?: { number: number }; issue?: { number: number } };
}

function quote(text: string): string {
	const flat = sanitizeText(text).replace(/\s+/g, " ").trim();
	return flat ? ` "${flat.length > 200 ? `${flat.slice(0, 200)}…` : flat}"` : "";
}

/** `baseSha`: current tip of the base branch, for open PRs only (the PR's own `baseRefOid` lags behind it). */
function prChanges(pr: PullRequest, baseSha?: string): Change[] {
	const changes: Change[] = [{ key: `state:${pr.state}`, text: `PR is now ${pr.state}` }];
	if (baseSha) {
		// A conflict gets its own line below, so the base line only states the other outcomes.
		const merge =
			pr.mergeable === "MERGEABLE"
				? "; the PR still merges cleanly"
				: pr.mergeable === "CONFLICTING"
					? ""
					: "; GitHub has not finished checking for conflicts yet (a conflict is reported once found)";
		changes.push({
			key: `base:${baseSha}`,
			text: `Base branch "${pr.baseRefName}" moved to ${baseSha.slice(0, 7)}${merge}`,
		});
		// Keyed by both tips: a conflict found after the base-move poll, or surviving a new push, is still news.
		if (pr.mergeable === "CONFLICTING") {
			changes.push({
				key: `conflict:${baseSha}:${pr.headRefOid}`,
				text: `CONFLICT: the PR has merge conflicts with "${pr.baseRefName}" (${baseSha.slice(0, 7)}) and needs a rebase or merge of the base`,
			});
		}
	}
	for (const review of pr.reviews) {
		changes.push({
			key: `review:${review.id}`,
			text: `Review ${review.state} by @${review.author?.login}:${quote(review.body)}`,
		});
	}
	for (const comment of pr.comments) {
		changes.push({
			key: `comment:${comment.id}`,
			text: `Comment by @${comment.author?.login}:${quote(comment.body)} ${comment.url}`,
		});
	}
	const sha = pr.headRefOid;
	const results = pr.statusCheckRollup.map(check => check.conclusion || check.state || "");
	pr.statusCheckRollup.forEach((check, index) => {
		const result = results[index] ?? "";
		if (!FAILED.has(result)) return;
		const name = check.name ?? check.context;
		changes.push({
			key: `check:${sha}:${name}:${result}`,
			text: `Check "${name}" ${result} on ${sha.slice(0, 7)}: ${check.detailsUrl ?? check.targetUrl ?? ""}`,
		});
	});
	if (results.length > 0 && results.every(result => PASSED.has(result))) {
		changes.push({ key: `checks-passed:${sha}`, text: `All checks passed on ${sha.slice(0, 7)}` });
	}
	return changes;
}

function repoChanges(events: RepoEvent[]): Change[] {
	return events.map(event => {
		const number = event.payload?.pull_request?.number ?? event.payload?.issue?.number;
		const details = [event.payload?.action, number && `#${number}`, event.payload?.ref].filter(Boolean).join(" ");
		return {
			key: `event:${event.id}`,
			text: `${event.type} by @${event.actor?.login}${details && ` (${details})`}`,
		};
	});
}

/** Normalizes a PR URL, repo URL, `owner/repo#N`, `#N`/`N` (current repo), `owner/repo`, or `auto`. */
function parseTarget(input: string): { repo?: string; number?: string } | typeof AUTO | undefined {
	const text = input.trim();
	if (text === AUTO) return AUTO;
	const match =
		/^(?:https?:\/\/|git@|ssh:\/\/git@)?github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/pull\/(\d+))?\/?(?:[?#].*)?$/.exec(
			text,
		) ??
		/^([\w.-]+\/[\w.-]+)(?:#(\d+))?$/.exec(text) ??
		/^()#?(\d+)$/.exec(text);
	if (!match) return undefined;
	return { repo: match[1] || undefined, number: match[2] };
}

export default function monitor(pi: ExtensionAPI): void {
	let watches: Watch[] = [];
	let cwd = process.cwd();
	let polling = false;

	async function gh(args: string[]): Promise<unknown> {
		const result = await pi.exec("gh", args, { cwd, timeout: 30_000 });
		if (result.code !== 0) throw new Error(sanitizeText(result.stderr.trim() || `gh exited with ${result.code}`));
		return JSON.parse(result.stdout);
	}

	async function snapshot(target: string): Promise<Snapshot | undefined> {
		if (target === AUTO) {
			// gh resolves the branch PR against its default repo, which is `upstream` in a fork checkout;
			// a PR opened inside the fork (origin) is only found by asking origin for the branch explicitly.
			let pr = (await gh(["pr", "view", "--json", PR_FIELDS]).catch(() => undefined)) as PullRequest | undefined;
			if (!pr) {
				const branch = (await pi.exec("git", ["branch", "--show-current"], { cwd })).stdout.trim();
				const origin = parseTarget((await pi.exec("git", ["remote", "get-url", "origin"], { cwd })).stdout);
				if (branch && origin !== AUTO && origin?.repo) {
					pr = (await gh(["pr", "view", branch, "--repo", origin.repo, "--json", PR_FIELDS]).catch(
						() => undefined,
					)) as PullRequest | undefined;
				}
			}
			// No PR for this branch (or no GitHub remote): nothing to watch yet; a PR opened later is picked up.
			return pr && prSnapshot(pr);
		}
		const [repo, number] = target.split("#");
		if (number) {
			return prSnapshot((await gh(["pr", "view", number, "--repo", repo, "--json", PR_FIELDS])) as PullRequest);
		}
		const events = (await gh(["api", `repos/${repo}/events?per_page=50`])) as RepoEvent[];
		return { subject: `https://github.com/${repo}`, changes: repoChanges(events) };
	}

	async function prSnapshot(pr: PullRequest): Promise<Snapshot> {
		const base = parseTarget(pr.url);
		let baseSha: string | undefined;
		if (pr.state === "OPEN" && base !== AUTO && base?.repo) {
			const result = await pi.exec("gh", ["api", `repos/${base.repo}/commits/${pr.baseRefName}`, "--jq", ".sha"], {
				cwd,
				timeout: 30_000,
			});
			if (result.code !== 0) throw new Error(sanitizeText(result.stderr.trim() || "gh api failed"));
			baseSha = result.stdout.trim();
		}
		return { subject: pr.url, changes: prChanges(pr, baseSha) };
	}

	async function poll(watch: Watch): Promise<void> {
		const snap = await snapshot(watch.target);
		if (!snap) return;
		// The first snapshot of a subject is the baseline: only later activity is news.
		if (!watch.seen || watch.subject !== snap.subject) {
			watch.subject = snap.subject;
			watch.seen = new Set(snap.changes.map(change => change.key));
			return;
		}
		const seen = watch.seen;
		const fresh = snap.changes.filter(change => !seen.has(change.key));
		if (fresh.length === 0) return;
		for (const change of fresh) seen.add(change.key);
		pi.sendMessage(
			{
				customType: "monitor-event",
				content: prompt.render(eventTemplate, { subject: snap.subject, changes: fresh.map(change => change.text) }),
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "aside", triggerTurn: true },
		);
	}

	async function tick(): Promise<void> {
		if (polling) return;
		polling = true;
		try {
			for (const watch of watches) {
				await poll(watch).catch(error => pi.logger.warn("monitor poll failed", { target: watch.target, error }));
			}
		} finally {
			polling = false;
		}
	}

	function save(): void {
		pi.appendEntry(STATE_ENTRY, { targets: watches.map(watch => watch.target) });
	}

	async function start(input: string): Promise<string> {
		const parsed = parseTarget(input);
		if (!parsed)
			throw new Error(`Unrecognized target "${input}". Use a PR/repo URL, owner/repo#N, #N, or owner/repo.`);
		let target: string = AUTO;
		if (parsed !== AUTO) {
			const repo =
				parsed.repo ??
				(
					await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd })
				).stdout.trim();
			if (!repo) throw new Error("No GitHub repository for the current directory; use owner/repo#N.");
			target = parsed.number ? `${repo}#${parsed.number}` : repo;
		}
		if (watches.some(watch => watch.target === target)) return `Already monitoring ${target}.`;
		const watch: Watch = { target };
		await poll(watch); // Validates the target and records the baseline before it is saved.
		watches.push(watch);
		save();
		return `Monitoring ${target}${watch.subject && watch.subject !== target ? ` (${watch.subject})` : ""}.`;
	}

	function stop(input: string): string {
		const text = input.trim();
		const remaining = watches.filter(
			watch =>
				text !== "all" &&
				watch.target !== text &&
				watch.subject !== text &&
				`#${watch.target.split("#")[1]}` !== text,
		);
		if (remaining.length === watches.length) return `Not monitoring ${text}. ${list()}`;
		watches = remaining;
		save();
		return `Stopped. ${list()}`;
	}

	function list(): string {
		if (watches.length === 0) return "No monitors active.";
		return `Monitoring: ${watches.map(watch => (watch.target === AUTO ? `auto (current branch PR${watch.subject ? `: ${watch.subject}` : ""})` : watch.target)).join(", ")}.`;
	}

	pi.on("before_agent_start", event => ({ systemPrompt: [...event.systemPrompt, context] }));

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		cwd = ctx.cwd;
		const saved = ctx.sessionManager
			.getBranch()
			.findLast(entry => entry.type === "custom" && entry.customType === STATE_ENTRY);
		const data = saved?.type === "custom" ? saved.data : undefined;
		const targets =
			isRecord(data) && Array.isArray(data.targets)
				? data.targets.filter(target => typeof target === "string")
				: [AUTO];
		watches = targets.map(target => ({ target }));
		ctx.setTimeout(tick, 0);
		ctx.setInterval(tick, POLL_MS);

		let logins: LoginState | undefined;
		const checkLogins = async () => {
			const current = await readLogins();
			const renewed = logins ? renewedLogins(logins, current) : [];
			logins = current;
			if (renewed.length === 0) return;
			pi.sendMessage(
				{
					customType: "monitor-login",
					content: prompt.render(loginTemplate, { logins: renewed }),
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "aside", triggerTurn: true },
			);
		};
		ctx.setTimeout(checkLogins, 0);
		ctx.setInterval(checkLogins, LOGIN_POLL_MS);
	});

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Watch GitHub for new activity and get woken with a monitor-event message when it happens. Use when the user asks to watch/monitor a pull request or repository. PR targets report new reviews, comments, failed checks, all-checks-passed, and merge/close; repository targets report new repository events. The current branch's PR is watched automatically as target `auto`. `target`: PR URL, owner/repo#N, #N (current repo), repository URL, owner/repo, `auto`, or `all` (stop only).",
		parameters: pi.arktype({ action: "'start' | 'stop' | 'list'", "target?": "string" }),
		async execute(
			_toolCallId,
			params: { action: "start" | "stop" | "list"; target?: string },
			_signal,
			_onUpdate,
			ctx,
		) {
			if (ctx.agent.kind !== "main") throw new Error("Monitors run only in the main session.");
			if (params.action === "list") return { content: [{ type: "text", text: list() }] };
			if (!params.target) throw new Error(`target is required for ${params.action}`);
			const text = params.action === "start" ? await start(params.target) : stop(params.target);
			return { content: [{ type: "text", text }] };
		},
	});

	pi.registerCommand("monitor", {
		description: "Watch a GitHub PR or repo: /monitor <target> | /monitor stop <target|all> | /monitor",
		handler: async (args, ctx) => {
			const [verb = "", ...rest] = args.trim().split(/\s+/);
			try {
				const text = verb === "" ? list() : verb === "stop" ? stop(rest.join(" ")) : await start(args);
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(sanitizeText(error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});
}
