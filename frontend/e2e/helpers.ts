import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API = `http://127.0.0.1:${process.env.E2E_BACKEND_PORT ?? 8765}`;
const tokens: Record<string, string> = {};

export async function login(request: APIRequestContext, user: string) {
  if (!tokens[user]) {
    const r = await request.post(`${API}/api/auth/login`, { data: { username: user, password: "demo1234" } });
    expect(r.ok()).toBeTruthy();
    tokens[user] = (await r.json()).access_token;
  }
  return { Authorization: `Bearer ${tokens[user]}` };
}

export async function call(request: APIRequestContext, user: string, method: "get" | "post" | "patch", path: string, data?: unknown) {
  const headers = await login(request, user);
  const r = await request[method](`${API}${path}`, { headers, data });
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status(), body };
}

export const step = (request: APIRequestContext, minutes: number) => call(request, "operator", "post", `/api/simulation/step?minutes=${minutes}`);

/** Browsers log every non-2xx fetch as a console error. The product deliberately triggers backend
 *  refusals (403/409/422) to demonstrate enforcement; those exact statuses are expected, anything else is not. */
const EXPECTED_DENIAL = /Failed to load resource: the server responded with a status of (403|409|422)/;

/** Collects unexpected console errors / page errors for the whole test. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !EXPECTED_DENIAL.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function twin<T>(page: Page, fn: (w: any) => T): Promise<T> {
  return page.evaluate((src) => new Function("w", `return (${src})(w)`)(window as any), fn.toString()) as Promise<T>;
}
