// Loopback fakes for `fx usage`. One handler answers every usage
// read fx makes, so a single fake gateway serves chat, models, and usage:
// AI Gateway's /v1/report and the Vercel usage-report budget. Every name and
// token here is synthetic.

import { writeFileSync } from "fs";

/** Mon Oct 12 2026 15:30 UTC: the 12th, so the month has finished days. */
export const USAGE_NOW_MS = Date.UTC(2026, 9, 12, 15, 30);
export const DAY_MS = 24 * 60 * 60 * 1000;

export type ReportRow = {
  model: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_cost: number;
};

export type UsageRequest = {
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  team: string | null;
};

type Answer = object | Response;

export type UsageFakeOptions = {
  /** Rows for one `/v1/report` range, by its UTC start and end dates. */
  report?: (start: string, end: string) => ReportRow[] | Response;
  budget?: Answer;
};

export function usageFake(options: UsageFakeOptions = {}) {
  const requests: UsageRequest[] = [];
  const reply = (value: Answer | undefined) =>
    value === undefined
      ? new Response("not found", { status: 404 })
      : value instanceof Response
      ? value.clone()
      : Response.json(value);
  const handler = (url: URL, request: Request): Response | null => {
    const routes: Record<string, () => Response> = {
      "/v1/report": () => {
        const rows = options.report?.(
          url.searchParams.get("start_date") ?? "",
          url.searchParams.get("end_date") ?? "",
        ) ?? [];
        return rows instanceof Response ? rows : Response.json({ results: rows });
      },
      "/ai-gateway/usage-report": () => reply(options.budget ?? { users: [] }),
    };
    const route = routes[url.pathname];
    if (!route) return null;
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      authorization: request.headers.get("authorization"),
      team: request.headers.get("x-vercel-ai-gateway-team"),
    });
    return route();
  };
  return {
    handler,
    requests,
    /** The `start..end` range of every `/v1/report` read, in order. */
    reportRanges() {
      return requests
        .filter((request) => request.path === "/v1/report")
        .map((request) =>
          `${request.query.get("start_date")}..${request.query.get("end_date")}`
        );
    },
  };
}

/** Points every usage origin at `baseUrl` and pins `/usage`'s clock. */
export function usageEnv(baseUrl: string, clockFile: string) {
  return {
    FX_GATEWAY_BASE_URL: baseUrl,
    FX_TEST_USAGE_CLOCK_FILE: clockFile,
    FX_DISABLE_KEYCHAIN: "1",
  };
}

export function writeUsageClock(path: string, ms: number): void {
  writeFileSync(path, `${ms}\n`);
}

/** `2026-10-12` for a time in milliseconds. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
