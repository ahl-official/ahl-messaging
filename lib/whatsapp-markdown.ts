// Minimal WhatsApp-style markdown renderer used for chat bubbles and
// the template-builder preview. Mirrors what the WhatsApp client itself
// renders on the customer's phone:
//   *bold*  _italic_  ~strike~  ```mono```  `code`
//   > quote (start of line)   * bullet (start of line)
//
// Boundary rules follow WhatsApp's behaviour: the marker must sit on a
// non-word boundary so things like `foo_bar_baz` (identifiers) and
// `2 * 3 = 6` (math) are left alone, while `*Hi*` / `_label_` /
// `~old~` flanked by punctuation or line breaks get formatted.
//
// Always HTML-escape first so user input can't inject tags.

export function renderWhatsAppMarkdown(raw: string): string {
  const esc = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return (
    esc
      // ```multi-line monospace``` — handle first so its contents don't
      // get mangled by the inline bold/italic passes.
      .replace(
        /```([\s\S]+?)```/g,
        '<code class="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.92em]">$1</code>',
      )
      // *bold* — opening * sits at start/non-word boundary; inner text
      // can't start or end with whitespace and can't contain another *.
      .replace(
        /(?<![*\w])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?![*\w])/g,
        "<strong>$1</strong>",
      )
      // _italic_ — same shape, underscore-flanked. Word-char-adjacent
      // underscores (e.g. snake_case) are left alone.
      .replace(
        /(?<![_\w])_([^\s_][^_\n]*?[^\s_]|[^\s_])_(?![_\w])/g,
        "<em>$1</em>",
      )
      // ~strikethrough~
      .replace(
        /(?<![~\w])~([^\s~][^~\n]*?[^\s~]|[^\s~])~(?![~\w])/g,
        "<s>$1</s>",
      )
      // `inline code` — applied after bold/italic so a single backtick
      // doesn't swallow an asterisk run by accident.
      .replace(
        /`([^`\n]+?)`/g,
        '<code class="rounded bg-black/10 px-1 font-mono text-[0.92em]">$1</code>',
      )
      // > blockquote at the start of a line. `>` is already escaped to
      // &gt; from the first pass, so match that form. Wrap the line in
      // a span with a left-border accent so the indentation reads as a
      // quote even inside a whitespace-pre-wrap paragraph.
      .replace(
        /(^|\n)&gt;\s?([^\n]*)/g,
        '$1<span class="inline-block border-l-2 border-current/40 pl-2 italic opacity-80">$2</span>',
      )
      // * bullet at the start of a line. Render as a real bullet glyph
      // so it reads like a list. Won't collide with *bold* because the
      // bold regex requires non-space content.
      .replace(/(^|\n)\*\s+([^\n]*)/g, "$1•&nbsp;$2")
  );
}
