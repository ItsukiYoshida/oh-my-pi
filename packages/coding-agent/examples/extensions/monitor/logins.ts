import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";

/** Credential stores the operator refreshes by hand (`aws sso login`, `gcloud auth login`), keyed by a stable name. */
export type LoginState = Map<string, string>;

async function mtime(file: string): Promise<string | undefined> {
	try {
		return String((await fs.stat(file)).mtimeMs);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Reads a fingerprint of each login without retaining any token value. */
export async function readLogins(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<LoginState> {
	const state: LoginState = new Map();
	const ssoCache = path.join(home, ".aws", "sso", "cache");
	let files: string[] = [];
	try {
		files = await fs.readdir(ssoCache);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	for (const file of files.filter(file => file.endsWith(".json"))) {
		const token: unknown = await Bun.file(path.join(ssoCache, file))
			.json()
			.catch(() => undefined);
		// Client registration files share the directory; only token files carry an access token.
		if (!isRecord(token) || typeof token.accessToken !== "string" || typeof token.expiresAt !== "string") continue;
		state.set(`AWS SSO ${typeof token.startUrl === "string" ? token.startUrl : file}`, token.expiresAt);
	}
	const gcloud = env.CLOUDSDK_CONFIG || path.join(home, ".config", "gcloud");
	// credentials.db holds refresh tokens (access tokens are cached in access_tokens.db), so it changes on login/revoke.
	for (const [name, file] of [
		["gcloud auth login", "credentials.db"],
		["gcloud auth application-default login", "application_default_credentials.json"],
	]) {
		const stamp = await mtime(path.join(gcloud, file));
		if (stamp) state.set(name, stamp);
	}
	return state;
}

/** Logins that appeared or were renewed since `before`. */
export function renewedLogins(before: LoginState, after: LoginState): string[] {
	return [...after].filter(([name, stamp]) => before.get(name) !== stamp).map(([name]) => name);
}
