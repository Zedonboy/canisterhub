// Message content renderer: plain-text segments still go through `Markdown`,
// but any http(s) URL that should be displayed as an image is lifted out and
// rendered as a real <img> instead. The agent's product answers carry
// inventory `image_url` links (see `order_inventory`'s ai_list_inventory),
// and the sender shouldn't have to know image markup for those to display -
// pasting the URL on its own line is enough. URLs that turn out not to be
// images (extensionless guesses) fall back to an ordinary link after the
// <img> fails, so guessing wrong never breaks the message.

import { useMemo, useState } from "react";
import { Markdown } from "./Markdown";

/** URLs with an obvious image extension embed even mid-sentence. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp|svg)([?#].*)?$/i;
/** Per-message cap on embedded images, bounding request volume from a single
 * (prompt-injected or customer-pasted) message. */
const MAX_EMBEDS = 4;
/** Bare URLs, but not ones already inside markdown link/image syntax
 * (`](...)` or `(...)`) or quotes - those stay in the text segment so the
 * authored markdown keeps working. */
const URL_PATTERN = /(?<![("'`])https?:\/\/[^\s<>"'()]*/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

interface Segment {
  kind: "text" | "image";
  value: string;
}

/** Splits message text into markdown segments and embeddable image URLs. A
 * URL embeds when it looks like an image file, or when it is the only thing
 * on its line (asset-storage URLs often have no extension to match on). */
export function segmentContent(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let embeds = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const url = raw.replace(TRAILING_PUNCTUATION, "");
    const end = start + url.length;

    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextBreak = text.indexOf("\n", end);
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    const standalone = text.slice(lineStart, start).trim() === "" && text.slice(end, lineEnd).trim() === "";

    const embed = IMAGE_EXTENSION.test(url) || (standalone && embeds < MAX_EMBEDS);
    if (!embed) continue;

    if (start > cursor) segments.push({ kind: "text", value: text.slice(cursor, start) });
    segments.push({ kind: "image", value: url });
    embeds += 1;
    cursor = end;
  }

  if (segments.length === 0) return [{ kind: "text", value: text }];
  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) });
  return segments;
}

/** An <img> attempt with a graceful link fallback: extensionless
 * asset-storage URLs can't be distinguished from ordinary links without
 * trying to load them. `referrerPolicy="no-referrer"` keeps the chat page's
 * origin (and its canister id) out of the image host's logs. */
function AutoImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="text-c-accent underline break-all">
        {url}
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" title={url} className="block">
      <img
        src={url}
        alt={url}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="block max-w-full max-h-64 rounded-lg border border-c-line"
      />
    </a>
  );
}

/** What `Bubble` renders: markdown for text, inline images for URLs the
 * sender (typically the agent, quoting an inventory image_url) wanted
 * displayed. */
export function MessageContent({ text }: { text: string }) {
  const segments = useMemo(() => segmentContent(text), [text]);
  if (segments.length === 1 && segments[0].kind === "text") {
    return <Markdown text={text} />;
  }
  return (
    <div className="space-y-2">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <Markdown key={index} text={segment.value} />
        ) : (
          <AutoImage key={`${segment.value}-${index}`} url={segment.value} />
        ),
      )}
    </div>
  );
}
