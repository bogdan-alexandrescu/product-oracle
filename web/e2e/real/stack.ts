import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** Ports, database and state file of the real-stack E2E (see playwright.real.config.ts). */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3200);
export const API_URL = `http://127.0.0.1:${API_PORT}`;
/** The fake Messages API discussion-stream.spec.ts starts; the API reads it as ORACLE_ANTHROPIC_API_URL. */
export const FAKE_CLAUDE_PORT = Number(process.env.E2E_FAKE_CLAUDE_PORT ?? 8199);
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql+asyncpg://oracle:oracle@localhost:5432/oracle_e2e";
export const STATE_FILE = path.resolve(__dirname, "../../test-results/e2e-real-state.json");

const API_DIR = path.resolve(__dirname, "../../../api");

/** Admin credentials and the API token written by reset_stack.py when the API starts. */
export function stackState(): { email: string; password: string; token: string } {
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

/** Runs the agent track's `oracle` CLI (from api/) against the E2E API. */
export async function oracle(...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("uv", ["run", "--quiet", "oracle", ...args], {
    cwd: API_DIR,
    env: { ...process.env, ORACLE_URL: API_URL, ORACLE_API_TOKEN: stackState().token },
  });
  return stdout;
}
