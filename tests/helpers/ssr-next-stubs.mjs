import React from "react";

// Stand-ins for the three `next/*` modules a Server Component page touches (see
// ./ssr-next-hooks.mjs). One module serves all three specifiers, so it exports the
// union of what they provide: `cookies`/`headers` (next/headers), `notFound`/
// `useRouter`/`redirect` (next/navigation) and the default `Link` (next/link).

/** The "current request", set by the test before it awaits the page. */
export const state = { cookie: null, ip: "ssr-stub-ip" };

export async function cookies() {
  return { get: (name) => (state.cookie && name === "tp_session_v1" ? { value: state.cookie } : undefined) };
}
export async function headers() {
  return new Headers({ "x-forwarded-for": state.ip });
}

/** Next's notFound() throws a NEXT_NOT_FOUND error; tests catch it by digest. */
export function notFound() {
  const error = new Error("NEXT_NOT_FOUND");
  error.digest = "NEXT_NOT_FOUND";
  throw error;
}
export function redirect() {
  const error = new Error("NEXT_REDIRECT");
  error.digest = "NEXT_REDIRECT";
  throw error;
}
export function useRouter() {
  return { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} };
}

export default function Link({ href, children, className }) {
  return React.createElement("a", { href, className }, children);
}
