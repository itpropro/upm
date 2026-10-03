// Highlighted text for the editor pane.
import { highlightText } from "rangi";
import { useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import type { Lines } from "../lib/route.ts";

/**
 * rangi escapes the text, so a tarball's own bytes are safe to put in as HTML. A click on a line
 * number picks that line, a shift-click the range to it, a click on the only picked line none.
 */
export function Code(props: {
  text: string;
  lang: string;
  lines?: Lines;
  onLines?: (lines: Lines | undefined) => void;
}) {
  const { text, lang, lines, onLines } = props;
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => rows(highlightText(text, { lang, lineNumbers: false })), [text, lang]);

  // Each line is two cells of the grid: its number, then its text.
  useLayoutEffect(() => {
    const grid = ref.current!.querySelector(".rows");
    if (!grid) return;
    for (const cell of grid.querySelectorAll(".sel")) cell.classList.remove("sel");
    if (!lines) return;
    const last = Math.min(lines[1], grid.children.length / 2);
    for (let i = lines[0]; i <= last; i++) {
      grid.children[2 * i - 2]!.classList.add("sel");
      grid.children[2 * i - 1]!.classList.add("sel");
    }
  }, [html, lines]);

  // A file that opens with lines picked, as from a link, scrolls to them.
  useLayoutEffect(() => {
    const box = ref.current!;
    const row = box.querySelector(".sel");
    if (!row) return;
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop -= box.clientHeight / 3;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  function pick(e: MouseEvent<HTMLDivElement>) {
    const number = (e.target as Element).closest(".n");
    if (!number || !onLines) return;
    const line = Number(number.textContent);
    if (e.shiftKey && lines) {
      onLines([Math.min(lines[0], line), Math.max(lines[0], line)]);
    } else {
      onLines(lines?.[0] === line && lines[1] === line ? undefined : [line, line]);
    }
  }

  return (
    <div
      ref={ref}
      onClick={pick}
      className={`code h-full overflow-auto pt-[calc(var(--covered-top,0px)+0.5rem)] pb-[calc(var(--covered-bottom,0px)+0.5rem)] pr-4 pl-4 font-mono has-[.n]:pl-0 text-xs leading-5 whitespace-pre-wrap wrap-anywhere ${onLines ? "pickable" : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * A number and a line per grid row, so a wrapped line keeps its number level. rangi's
 * spans are flat; one that crosses a line break is closed and opened again.
 */
function rows(html: string): string {
  const lines = html
    .replace(/^(<div[^>]*>){2}/, "")
    .replace(/(<\/div>){2}$/, "")
    .split("\n");
  if (lines.length < 2) return html;
  let open = "";
  let out = "";
  for (const [i, line] of lines.entries()) {
    const start = open;
    const s = line.lastIndexOf("<span");
    const e = line.lastIndexOf("</span>");
    if (s > e) open = line.slice(s, line.indexOf(">", s) + 1);
    else if (e >= 0) open = "";
    out += `<div class="n">${i + 1}</div><div>${start}${line}${open && "</span>"}</div>`;
  }
  return `<div class="rows">${out}</div>`;
}

const MAX_PREVIEW = 256 * 1024;

/** File names rangi does not know as a language of their own. */
const LANGS: Record<string, string> = { map: "json", license: "plain", licence: "plain" };

export function preview(path: string, data: Uint8Array): { text: string; lang: string } {
  const head = data.subarray(0, MAX_PREVIEW);
  if (head.includes(0)) return { text: `(binary, ${formatBytes(data.length)})`, lang: "plain" };
  const text = new TextDecoder().decode(head);
  // An extension, else the whole name (`Makefile`); rangi takes either and falls back to plain.
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = base.slice(base.lastIndexOf(".") + 1);
  return {
    text: data.length > MAX_PREVIEW ? `${text}\n… (${formatBytes(data.length)} in all)` : text,
    lang: LANGS[ext] ?? ext,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
