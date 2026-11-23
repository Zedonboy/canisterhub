//! Renders the model's markdown into the small HTML subset Telegram accepts
//! (`parse_mode: "HTML"`): `<b> <i> <s> <code> <pre> <a> <blockquote>`.
//! Standard HTML output (`<p>`, `<h1>`, `<ul>`...) is rejected by Telegram, so
//! this walks `pulldown-cmark`'s events instead of using its HTML renderer.
//! Only `&`, `<` and `>` need escaping in this mode, and every piece of text -
//! including raw HTML in the markdown - is escaped, never passed through.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// Telegram rejects over 4096 characters; HTML escaping only ever makes the
/// text longer than what Telegram counts, so this is a safe margin.
pub const MAX_CHARS: usize = 4_000;

/// One message to send. `plain` is the same content without formatting, used
/// when Telegram refuses the HTML.
#[derive(Debug, PartialEq, Eq)]
pub struct Chunk {
    pub html: String,
    pub plain: String,
    pub is_html: bool,
}

fn escape(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}

fn safe_link(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["http://", "https://", "tg://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

#[derive(Default)]
struct Block {
    html: String,
    plain: String,
}

#[derive(Default)]
struct Renderer {
    blocks: Vec<Block>,
    cur: Block,
    /// Next number for each open list (`None` = bullets).
    lists: Vec<Option<u64>>,
    quote_depth: usize,
    /// Whether each open link was emitted as an `<a>` (unsafe schemes aren't).
    links: Vec<bool>,
}

impl Renderer {
    fn top_level(&self) -> bool {
        self.lists.is_empty() && self.quote_depth == 0
    }

    fn text(&mut self, t: &str) {
        escape(t, &mut self.cur.html);
        self.cur.plain.push_str(t);
    }

    fn raw(&mut self, html: &str) {
        self.cur.html.push_str(html);
    }

    fn newline(&mut self) {
        self.cur.html.push('\n');
        self.cur.plain.push('\n');
    }

    /// Ends a block: a top-level one becomes its own paragraph-level piece,
    /// a nested one (list item, quote) just ends its line.
    fn end_block(&mut self) {
        if self.top_level() {
            self.flush();
        } else if !self.cur.html.ends_with('\n') {
            self.newline();
        }
    }

    fn flush(&mut self) {
        let html = self.cur.html.trim_end().to_string();
        let plain = self.cur.plain.trim_end().to_string();
        if !html.is_empty() {
            self.blocks.push(Block { html, plain });
        }
        self.cur = Block::default();
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Strong => self.raw("<b>"),
                Tag::Emphasis => self.raw("<i>"),
                Tag::Strikethrough => self.raw("<s>"),
                Tag::Heading { .. } => self.raw("<b>"),
                Tag::CodeBlock(_) => self.raw("<pre>"),
                Tag::BlockQuote(_) => {
                    self.quote_depth += 1;
                    self.raw("<blockquote>");
                }
                Tag::List(start) => self.lists.push(start),
                Tag::Item => {
                    let indent = "  ".repeat(self.lists.len().saturating_sub(1));
                    let marker = match self.lists.last_mut() {
                        Some(Some(n)) => {
                            let m = format!("{n}. ");
                            *n += 1;
                            m
                        }
                        _ => "• ".to_string(),
                    };
                    self.text(&format!("{indent}{marker}"));
                }
                Tag::Link { dest_url, .. } => {
                    let ok = safe_link(&dest_url);
                    if ok {
                        let mut href = String::new();
                        escape(dest_url.trim(), &mut href);
                        self.raw(&format!("<a href=\"{href}\">"));
                    }
                    self.links.push(ok);
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Strong => self.raw("</b>"),
                TagEnd::Emphasis => self.raw("</i>"),
                TagEnd::Strikethrough => self.raw("</s>"),
                TagEnd::Heading(_) => {
                    self.raw("</b>");
                    self.end_block();
                }
                TagEnd::Paragraph => self.end_block(),
                TagEnd::CodeBlock => {
                    // Code text ends in a newline that would show inside <pre>.
                    let trimmed = self.cur.html.trim_end_matches('\n').len();
                    self.cur.html.truncate(trimmed);
                    self.raw("</pre>");
                    self.end_block();
                }
                TagEnd::BlockQuote(_) => {
                    let trimmed = self.cur.html.trim_end_matches('\n').len();
                    self.cur.html.truncate(trimmed);
                    self.raw("</blockquote>");
                    self.quote_depth = self.quote_depth.saturating_sub(1);
                    self.end_block();
                }
                TagEnd::List(_) => {
                    self.lists.pop();
                    if self.top_level() {
                        self.flush();
                    }
                }
                TagEnd::Item => {
                    if !self.cur.html.ends_with('\n') {
                        self.newline();
                    }
                }
                TagEnd::Link => {
                    if self.links.pop() == Some(true) {
                        self.raw("</a>");
                    }
                }
                _ => {}
            },
            Event::Text(t) | Event::Html(t) | Event::InlineHtml(t) => self.text(&t),
            Event::Code(c) => {
                self.raw("<code>");
                self.text(&c);
                self.raw("</code>");
            }
            Event::SoftBreak | Event::HardBreak => self.newline(),
            Event::Rule => {
                self.text("──────────");
                self.flush();
            }
            Event::TaskListMarker(done) => self.text(if done { "☑ " } else { "☐ " }),
            _ => {}
        }
    }
}

fn blocks(markdown: &str) -> Vec<Block> {
    let mut r = Renderer::default();
    for event in Parser::new_ext(markdown, Options::ENABLE_STRIKETHROUGH) {
        r.event(event);
    }
    r.flush();
    r.blocks
}

/// Converts `markdown` into messages that each fit Telegram's length limit.
/// Messages break between blocks so no tag is ever cut in half; a single
/// block too long for one message is sent as plain text, split at line or
/// word boundaries.
pub fn render(markdown: &str) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = Vec::new();
    let mut cur = Chunk {
        html: String::new(),
        plain: String::new(),
        is_html: true,
    };
    for block in blocks(markdown) {
        if block.html.chars().count() > MAX_CHARS {
            if !cur.html.is_empty() {
                out.push(std::mem::replace(
                    &mut cur,
                    Chunk { html: String::new(), plain: String::new(), is_html: true },
                ));
            }
            for piece in split_plain(&block.plain) {
                let mut html = String::new();
                escape(&piece, &mut html);
                out.push(Chunk { html, plain: piece, is_html: false });
            }
            continue;
        }
        let joined = cur.html.chars().count() + 2 + block.html.chars().count();
        if !cur.html.is_empty() && joined > MAX_CHARS {
            out.push(std::mem::replace(
                &mut cur,
                Chunk { html: String::new(), plain: String::new(), is_html: true },
            ));
        }
        if !cur.html.is_empty() {
            cur.html.push_str("\n\n");
            cur.plain.push_str("\n\n");
        }
        cur.html.push_str(&block.html);
        cur.plain.push_str(&block.plain);
    }
    if !cur.html.is_empty() {
        out.push(cur);
    }
    if out.is_empty() {
        out.push(Chunk { html: String::new(), plain: String::new(), is_html: true });
    }
    out
}

/// Splits plain text into pieces of at most `MAX_CHARS`, preferring to break
/// at a newline or space.
pub fn split_plain(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while rest.chars().count() > MAX_CHARS {
        let hard = rest
            .char_indices()
            .nth(MAX_CHARS)
            .map_or(rest.len(), |(i, _)| i);
        let cut = rest[..hard]
            .rfind('\n')
            .or_else(|| rest[..hard].rfind(' '))
            .filter(|i| *i > 0)
            .unwrap_or(hard);
        out.push(rest[..cut].to_string());
        rest = rest[cut..].trim_start();
    }
    out.push(rest.to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(md: &str) -> String {
        let chunks = render(md);
        assert_eq!(chunks.len(), 1, "{chunks:?}");
        chunks[0].html.clone()
    }

    #[test]
    fn inline_formatting_maps_to_telegram_tags() {
        assert_eq!(
            one("**bold** _it_ ~~gone~~ `code`"),
            "<b>bold</b> <i>it</i> <s>gone</s> <code>code</code>"
        );
    }

    #[test]
    fn headings_paragraphs_and_lists() {
        assert_eq!(
            one("# Menu\n\nToday:\n\n- jollof\n- rice\n\n1. one\n2. two"),
            "<b>Menu</b>\n\nToday:\n\n• jollof\n• rice\n\n1. one\n2. two"
        );
    }

    #[test]
    fn code_blocks_and_quotes() {
        assert_eq!(one("```\nlet a = 1 < 2;\n```"), "<pre>let a = 1 &lt; 2;</pre>");
        assert_eq!(one("> quoted"), "<blockquote>quoted</blockquote>");
    }

    #[test]
    fn raw_html_and_special_characters_are_escaped() {
        let html = one("<script>alert(1)</script> & done");
        assert!(!html.contains("<script>"), "{html}");
        assert!(html.contains("&lt;script&gt;") && html.contains("&amp;"), "{html}");
    }

    #[test]
    fn only_safe_link_schemes_become_anchors() {
        assert_eq!(
            one("[ok](https://example.com/a?b=1&c=2)"),
            "<a href=\"https://example.com/a?b=1&amp;c=2\">ok</a>"
        );
        assert_eq!(one("[bad](javascript:alert(1))"), "bad");
    }

    #[test]
    fn plain_text_passes_through_and_empty_input_gives_one_message() {
        assert_eq!(one("just text"), "just text");
        assert_eq!(render("").len(), 1);
    }

    #[test]
    fn long_replies_split_between_blocks_without_cutting_tags() {
        let para = format!("**{}**", "word ".repeat(300).trim());
        let md = vec![para; 8].join("\n\n");
        let chunks = render(&md);
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.is_html && c.html.chars().count() <= MAX_CHARS);
            assert_eq!(c.html.matches("<b>").count(), c.html.matches("</b>").count());
        }
    }

    #[test]
    fn one_oversized_block_falls_back_to_split_plain_text() {
        let md = "word ".repeat(2_000);
        let chunks = render(&md);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| !c.is_html && c.html.chars().count() <= MAX_CHARS));
    }
}
