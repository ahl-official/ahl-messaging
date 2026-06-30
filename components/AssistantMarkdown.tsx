"use client";

// Minimal markdown renderer for the home assistant's replies. Handles
// the subset our reports + tool answers actually emit:
//   - ### headings
//   - **bold** + *italic*  +  `code`
//   - - / * bullet lists
//   - 1. ordered lists
//   - blank-line paragraph breaks + inline newlines
//
// We deliberately don't pull react-markdown / remark in — those add
// 60 kB+ of bundle to render formatting that's two regex away. Inputs
// are also entirely model-generated so we don't need full GFM support.

import { Fragment, type ReactNode } from "react";

interface Props {
  text: string;
}

export function AssistantMarkdown({ text }: Props) {
  return <>{renderBlocks(text)}</>;
}

// Block-level: split into paragraphs / lists / headings on blank lines
// + the leading marker of each line.
function renderBlocks(src: string): ReactNode {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty separators between blocks.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Heading (###, ##, #).
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 4);
      const tag = (`h${level + 2}` as unknown) as keyof JSX.IntrinsicElements;
      out.push(
        <Tag
          key={key++}
          tag={tag}
          className={
            level <= 2
              ? "mt-1 mb-1.5 text-sm font-bold text-foreground"
              : "mt-1 mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground"
          }
        >
          {renderInline(h[2])}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // Bullet list group (- / *).
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      out.push(
        <ul key={key++} className="my-1 list-disc space-y-0.5 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list group (1. / 2. …).
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(
        <ol key={key++} className="my-1 list-decimal space-y-0.5 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — collapse a run of non-blank, non-list, non-heading
    // lines into one <p>.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(
      <p key={key++} className="my-1 whitespace-pre-wrap leading-snug">
        {renderInline(para.join("\n"))}
      </p>,
    );
  }

  return out;
}

// Inline: **bold**, *italic*, `code`. Process bold first (greedy on
// **) so an "**a *b* c**" still bolds the whole span.
function renderInline(src: string): ReactNode {
  // Three passes: bold, italic, code. Each splits + wraps matches.
  const boldParts = splitWrap(src, /\*\*(.+?)\*\*/g, (inner, k) => (
    <strong key={k} className="font-semibold">
      {renderItalicAndCode(inner)}
    </strong>
  ));
  return (
    <>
      {boldParts.map((p, idx) => (
        <Fragment key={idx}>
          {typeof p === "string" ? renderItalicAndCode(p) : p}
        </Fragment>
      ))}
    </>
  );
}

function renderItalicAndCode(src: string): ReactNode {
  const italicParts = splitWrap(src, /\*(?!\s)(.+?)\*/g, (inner, k) => (
    <em key={k} className="italic">
      {renderCode(inner)}
    </em>
  ));
  return (
    <>
      {italicParts.map((p, idx) => (
        <Fragment key={idx}>
          {typeof p === "string" ? renderCode(p) : p}
        </Fragment>
      ))}
    </>
  );
}

function renderCode(src: string): ReactNode {
  const parts = splitWrap(src, /`([^`]+)`/g, (inner, k) => (
    <code
      key={k}
      className="rounded bg-foreground/5 px-1 py-0.5 font-mono text-[11px] text-foreground"
    >
      {inner}
    </code>
  ));
  return (
    <>
      {parts.map((p, idx) => (
        <Fragment key={idx}>{p}</Fragment>
      ))}
    </>
  );
}

// Walks `src` with `re`, returning an alternating array of plain
// strings and React nodes produced by `wrap` for each match.
function splitWrap(
  src: string,
  re: RegExp,
  wrap: (inner: string, key: number) => ReactNode,
): Array<string | ReactNode> {
  const out: Array<string | ReactNode> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    out.push(wrap(m[1], key++));
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// Tiny wrapper so renderBlocks can pick the heading tag dynamically
// without TypeScript fighting JSX intrinsic-element typing.
function Tag({
  tag,
  className,
  children,
}: {
  tag: keyof JSX.IntrinsicElements;
  className?: string;
  children: ReactNode;
}) {
  const T = tag as unknown as React.ElementType;
  return <T className={className}>{children}</T>;
}
