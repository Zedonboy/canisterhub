//! Summarize-then-embed pipeline behind both indexing (`POST
//! /index_marketplace_item`) and search (`search_marketplace`'s tool): a
//! marketplace item's raw description is condensed into a short summary +
//! keywords via whichever LLM `LLM_PROVIDER` names (same provider the
//! orchestration agent reasons with), then *that* text is embedded with
//! OpenAI's `text-embedding-3-small` - always OpenAI here, regardless of
//! `LLM_PROVIDER`, since `hnsw_index`'s collection dimension (1536) is fixed
//! to that specific model.

use crate::config::Config;
use crate::ic::types::MarketplaceItem;
use rig::prelude::*;
use rig::providers::openai;
use serde::Deserialize;

#[derive(Deserialize)]
struct SummaryAndKeywords {
    summary: String,
    keywords: Vec<String>,
}

const SUMMARIZER_PREAMBLE: &str = "\
You condense a marketplace listing's description into a short summary and a \
handful of keywords, for semantic search. Respond with ONLY a JSON object \
matching exactly this shape, no other text, no markdown fences:

{\"summary\": \"...\", \"keywords\": [\"...\", \"...\"]}

The summary must be 1-3 plain-English sentences describing what the canister \
actually does. Keywords must be short (1-3 words each), specific nouns or \
phrases a user searching for this canister might type - not generic filler \
like \"canister\" or \"Internet Computer\".";

/// Condenses a description into (summary, keywords) via the configured LLM.
/// Runs as a single-turn, tool-free agent call - see `llm::run_agent`. Not
/// attributed to any job's `token_usage` (`llm::AgentRunOutcome::usage` is
/// discarded here) - this runs outside the job/pipeline model entirely, for
/// marketplace indexing and search, not for building a particular project.
pub async fn summarize_and_extract_keywords(
    cfg: &Config,
    description: &str,
) -> anyhow::Result<(String, Vec<String>)> {
    let response =
        crate::llm::run_agent(cfg, SUMMARIZER_PREAMBLE, vec![], description.to_string(), 1)
            .await
            .result?;
    let json_text = extract_json_object(&response)?;
    let parsed: SummaryAndKeywords = serde_json::from_str(json_text).map_err(|e| {
        anyhow::anyhow!("failed to parse summarizer output as JSON: {e} (raw output: {response})")
    })?;
    Ok((parsed.summary, parsed.keywords))
}

/// Models sometimes wrap JSON in prose or a fenced code block despite being
/// told not to - tolerate that by taking the outermost `{...}` span rather
/// than failing outright on anything but a bare JSON object.
fn extract_json_object(text: &str) -> anyhow::Result<&str> {
    let start = text
        .find('{')
        .ok_or_else(|| anyhow::anyhow!("no JSON object found in model output: {text}"))?;
    let end = text
        .rfind('}')
        .ok_or_else(|| anyhow::anyhow!("no JSON object found in model output: {text}"))?;
    if end <= start {
        anyhow::bail!("no JSON object found in model output: {text}");
    }
    Ok(&text[start..=end])
}

/// The exact text embedded for one marketplace item: title, summary, and
/// keywords together make a better embedding input than the raw description
/// alone (often longer, noisier prose) while still anchoring on the item's
/// actual name.
pub fn embedding_input(item: &MarketplaceItem, summary: &str, keywords: &[String]) -> String {
    format!(
        "{}\n\n{}\n\nKeywords: {}",
        item.title,
        summary,
        keywords.join(", ")
    )
}

/// Always OpenAI - see this module's doc comment for why that's not
/// `LLM_PROVIDER`-dependent like `summarize_and_extract_keywords` is.
pub async fn embed_text(text: &str) -> anyhow::Result<Vec<f32>> {
    let client = openai::Client::from_env().map_err(|e| {
        anyhow::anyhow!(
            "failed to build OpenAI client for embeddings (is OPENAI_API_KEY set?): {e}"
        )
    })?;
    let model = client.embedding_model(openai::TEXT_EMBEDDING_3_SMALL);
    let embedding = model.embed_text(text).await?;
    Ok(embedding.vec.into_iter().map(|x| x as f32).collect())
}
