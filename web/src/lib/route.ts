// Routes: `/` is the landing, `/docs` the README, `/npm/<spec>` the app for a spec, where
// `?file=<tree path>&line=<n>[-<m>]` opens a file at its lines.
// Any other `/<spec>` redirects to `/npm/<spec>`.

export const NPM = "/npm/";
export const DOCS = /^\/docs\/?$/;

/** The spec in a `/npm/<spec>` path. */
export function specOf(pathname: string): string {
  return decodeURIComponent(pathname.slice(NPM.length)).replace(/\/$/, "");
}

/** A spec's path; a scope's `@` and `/` stay readable. */
export function pathOf(spec: string): string {
  return NPM + encodeURIComponent(spec).replace(/%40/g, "@").replace(/%2F/gi, "/");
}

/** A range of lines, first and last, from 1. */
export type Lines = [from: number, to: number];

/** The open file and its picked lines, as a `/npm/<spec>` path's query keeps them. */
export function openOf(search: string): { file?: string; lines?: Lines } {
  const query = new URLSearchParams(search);
  const file = query.get("file") || undefined;
  const match = /^(\d+)(?:-(\d+))?$/.exec(query.get("line") ?? "");
  if (!file || !match) return { file };
  const from = Number(match[1]);
  const to = Number(match[2] ?? from);
  return from > 0 ? { file, lines: [Math.min(from, to), Math.max(from, to)] } : { file };
}

/** The query for an open file; its path's `/` and `@` stay readable. */
export function searchOf(file: string | undefined, lines?: Lines): string {
  if (!file) return "";
  const path = encodeURIComponent(file).replace(/%40/g, "@").replace(/%2F/gi, "/");
  const line = !lines ? "" : lines[0] === lines[1] ? lines[0] : `${lines[0]}-${lines[1]}`;
  return `?file=${path}${line && `&line=${line}`}`;
}

/** Specs worth a try, offered on both pages: build and UI, then full-stack frameworks, then servers, then upm itself. */
export const EXAMPLES = [
  "vite",
  "vue",
  "nuxt",
  "next",
  "@tanstack/react-start",
  "nitro",
  "h3",
  "express",
  "upm",
];
