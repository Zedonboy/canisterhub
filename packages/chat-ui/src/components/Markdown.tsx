import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

/** Render assistant and customer messages as Markdown, including GFM tables.
 * react-markdown does not enable raw HTML by default. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true, async: false })),
    [text],
  );
  return (
    <div
      className="space-y-2 [&_a]:text-c-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-c-accent-a44 [&_blockquote]:pl-2 [&_blockquote]:text-c-muted [&_img]:block [&_img]:max-w-full [&_img]:rounded-lg [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_pre]:my-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/10 [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-xs [&_th]:border-b [&_th]:border-current/20 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_td]:border-b [&_td]:border-current/10 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
