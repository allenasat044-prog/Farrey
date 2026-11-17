import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

marked.setOptions({ gfm: true, breaks: false });

/** Render markdown into `root`. Task-list checkboxes become clickable and are
 *  numbered (data-task) in document order. */
export function renderMarkdown(src: string, root: HTMLElement) {
  const html = marked.parse(src, { async: false }) as string;
  root.innerHTML = DOMPurify.sanitize(html);

  root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
    box.disabled = false;
    box.dataset.task = String(i);
  });

  root.querySelectorAll<HTMLElement>('pre code[class*="language-"]').forEach((el) => {
    try {
      hljs.highlightElement(el);
    } catch {
      /* unknown language: leave as plain code */
    }
  });
}

/* ---------- task-list write-back ---------- */

const FENCE_RE = /^\s*(?:>\s*)*(`{3,}|~{3,})/;
const TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=[ \t])/;

/** Line numbers of every task-list item in the source, in order, skipping fenced code. */
export function findTaskLines(src: string): number[] {
  const lines = src.split("\n");
  const found: number[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (TASK_RE.test(line)) found.push(i);
  }
  return found;
}

/** Flip the checkbox on one line of the source and return the new source. */
export function toggleTaskLine(src: string, lineIndex: number): string {
  const lines = src.split("\n");
  lines[lineIndex] = lines[lineIndex].replace(
    TASK_RE,
    (_m, prefix: string, mark: string) => `${prefix}[${mark === " " ? "x" : " "}]`,
  );
  return lines.join("\n");
}
