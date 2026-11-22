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

export interface RenderOptions {
  /** Loads a relative image (`./shot.png`) and returns a URL the page can show. */
  resolveImage?: (src: string) => Promise<string>;
}

/** True for a path inside the project (`./a.png`, `docs/a.md`, `/a.png`); false for
 *  web links, `data:` images, `#anchors` and anything else with a scheme. */
export function isLocalTarget(target: string): boolean {
  const t = target.trim();
  if (!t || t.startsWith("#") || t.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]+:/i.test(t);
}

/** GitHub-style heading slug: lower case, punctuation removed, spaces become hyphens. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

// Heading ids get a prefix so they can never clash with the app's own element ids.
const HEADING_PREFIX = "md-";

function addHeadingIds(root: HTMLElement) {
  const used = new Map<string, number>();
  root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const base = slugify(h.textContent ?? "") || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    h.id = HEADING_PREFIX + (n === 0 ? base : `${base}-${n}`);
  });
}

/** Scroll to the heading a `#fragment` link points at. Returns false if there is none. */
export function scrollToAnchor(root: HTMLElement, fragment: string): boolean {
  let wanted = fragment;
  try {
    wanted = decodeURIComponent(fragment);
  } catch {
    /* keep the raw text */
  }
  const target = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
    (el) => el.id === HEADING_PREFIX + slugify(wanted),
  );
  if (!target) return false;
  target.scrollIntoView({ block: "start" });
  return true;
}

export interface Heading {
  id: string;
  text: string;
  level: number;
}

/** The headings of a rendered README, in order, for the table of contents. */
export function collectHeadings(root: HTMLElement): Heading[] {
  return Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    .filter((h) => h.id)
    .map((h) => ({
      id: h.id,
      text: (h.textContent ?? "").trim(),
      level: Number(h.tagName.slice(1)),
    }));
}

/** Render markdown into `root`. Task-list checkboxes become clickable and are
 *  numbered (data-task) in document order. */
export function renderMarkdown(
  src: string,
  root: HTMLElement,
  options: RenderOptions = {},
) {
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

  addHeadingIds(root);

  const resolveImage = options.resolveImage;
  if (resolveImage) {
    root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const original = img.getAttribute("src") ?? "";
      if (!isLocalTarget(original)) return;
      img.dataset.local = original;
      img.removeAttribute("src");
      img.classList.add("img-loading");
      resolveImage(original)
        .then((url) => {
          img.classList.remove("img-loading");
          img.src = url;
        })
        .catch((err) => {
          img.classList.remove("img-loading");
          img.classList.add("img-missing");
          img.title = String(err);
        });
    });
  }
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
