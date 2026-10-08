// The GitHub CLI implementation of GithubPublisher, shared by the publisher
// command and the review server. `gh` keeps the credentials; nothing here
// reads or returns a token.

import { spawnSync } from "node:child_process";
import type {
  GithubPublicationContext,
  GithubPublisher,
  GithubReviewRequest,
} from "./github-review.mjs";

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs `gh` with an argument array (no shell) and optional standard input. */
export type GhRunner = (args: readonly string[], input?: string) => GhResult;

export const defaultGhRunner: GhRunner = (args, input) => {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    input,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {}),
  };
};

export function createGhPublisher(run: GhRunner = defaultGhRunner): GithubPublisher {
  const gh = (args: readonly string[], input?: string): string => {
    const result = run(args, input);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `gh exited ${result.status}`).trim());
    }
    return result.stdout.trim();
  };
  return {
    async isAuthenticated(): Promise<boolean> {
      const result = run(["auth", "status", "--hostname", "github.com"]);
      return !result.error && result.status === 0;
    },
    async currentHead(target: GithubPublicationContext): Promise<string> {
      return gh([
        "api",
        `repos/${target.repository}/pulls/${target.pullRequest}`,
        "--jq",
        ".head.sha",
      ]);
    },
    async createReview(
      target: GithubPublicationContext,
      request: GithubReviewRequest,
    ): Promise<{ url?: string }> {
      const url = gh(
        [
          "api",
          "--method",
          "POST",
          `repos/${target.repository}/pulls/${target.pullRequest}/reviews`,
          "--input",
          "-",
          "--jq",
          ".html_url",
        ],
        JSON.stringify(request),
      );
      return url ? { url } : {};
    },
  };
}
