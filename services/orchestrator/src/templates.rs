//! Validated, declarative project templates used by the marketplace.
//! Manifests are data, never shell fragments: identifiers and dependency
//! references are checked before a template can enter the catalog.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_PACKAGES: usize = 32;
const MAX_CONFIGURE_STEPS: usize = 64;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateManifest {
    pub schema_version: u32,
    pub template: TemplateMetadata,
    #[serde(default)]
    pub packages: Vec<TemplatePackage>,
    #[serde(default)]
    pub configure: Vec<ConfigureStep>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateMetadata {
    pub name: String,
    pub slug: String,
    pub version: String,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplatePackage {
    /// Stable logical name used by dependencies and `${name.canister_id}`.
    pub name: String,
    /// Absolute HTTP(S) location used to resolve this package.
    pub url: String,
    #[serde(default = "yes")]
    pub required: bool,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigureStep {
    pub target: String,
    pub method: String,
    pub args: String,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
pub struct TemplateSummary {
    pub name: String,
    pub slug: String,
    pub version: String,
    pub description: String,
    pub category: String,
    pub tags: Vec<String>,
    pub package_count: usize,
}

impl TemplateManifest {
    pub fn summary(&self) -> TemplateSummary {
        TemplateSummary {
            name: self.template.name.clone(),
            slug: self.template.slug.clone(),
            version: self.template.version.clone(),
            description: self.template.description.clone(),
            category: self.template.category.clone(),
            tags: self.template.tags.clone(),
            package_count: self.packages.len(),
        }
    }

    pub fn ordered_packages(&self) -> Result<Vec<TemplatePackage>, String> {
        let by_name: HashMap<_, _> = self.packages.iter().map(|p| (p.name.as_str(), p)).collect();
        let mut done = HashSet::new();
        let mut result = Vec::with_capacity(self.packages.len());
        while result.len() < self.packages.len() {
            let before = result.len();
            for package in &self.packages {
                if !done.contains(package.name.as_str())
                    && package.depends_on.iter().all(|d| done.contains(d.as_str()))
                {
                    done.insert(package.name.as_str());
                    result.push(package.clone());
                }
            }
            if result.len() == before {
                return Err("package dependency graph contains a cycle".into());
            }
        }
        debug_assert_eq!(by_name.len(), result.len());
        Ok(result)
    }

    pub fn validate(&self, directory_slug: &str) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("unsupported schema_version (expected 1)".into());
        }
        if self.template.slug != directory_slug {
            return Err("template.slug must match its directory name".into());
        }
        safe_slug(&self.template.slug, "template.slug")?;
        if self.template.name.trim().is_empty() || self.template.description.trim().is_empty() {
            return Err("template name and description must not be empty".into());
        }
        if self.packages.is_empty() || self.packages.len() > MAX_PACKAGES {
            return Err(format!("packages must contain 1..={MAX_PACKAGES} entries"));
        }
        if self.configure.len() > MAX_CONFIGURE_STEPS {
            return Err(format!(
                "configure may contain at most {MAX_CONFIGURE_STEPS} entries"
            ));
        }
        let mut names = HashSet::new();
        for p in &self.packages {
            safe_slug(&p.name, "package.name")?;
            if !names.insert(p.name.as_str()) {
                return Err(format!("duplicate package name `{}`", p.name));
            }
            if p.url.is_empty() || p.url.len() > 2048 {
                return Err(format!("package `{}` has an invalid URL", p.name));
            }
            if !(p.url.starts_with("https://") || p.url.starts_with("http://")) {
                return Err(format!("package `{}` URL must use HTTP or HTTPS", p.name));
            }
        }
        for p in &self.packages {
            for dep in &p.depends_on {
                if dep == &p.name || !names.contains(dep.as_str()) {
                    return Err(format!(
                        "package `{}` has invalid dependency `{dep}`",
                        p.name
                    ));
                }
            }
        }
        for step in &self.configure {
            if !names.contains(step.target.as_str()) {
                return Err(format!("configure target `{}` does not exist", step.target));
            }
            safe_method(&step.method)?;
            validate_placeholders(&step.args, &names)?;
        }
        for (key, value) in &self.environment {
            if key.is_empty()
                || !key
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                return Err(format!("invalid environment key `{key}`"));
            }
            validate_placeholders(value, &names)?;
        }
        self.ordered_packages()?;
        Ok(())
    }
}

/// Downloads and validates one marketplace template manifest. The backend
/// constrains the URL to the publisher's GitHub release, and this layer still
/// applies a strict response-size limit and the same schema validation used
/// for repository-local manifests.
pub async fn download_manifest(
    client: &reqwest::Client,
    url: &str,
) -> Result<TemplateManifest, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not download template manifest: {e}"))?
        .error_for_status()
        .map_err(|e| format!("could not download template manifest: {e}"))?;
    if response.content_length().is_some_and(|length| length > MAX_MANIFEST_BYTES) {
        return Err(format!("template manifest exceeds {MAX_MANIFEST_BYTES} bytes"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("could not read template manifest: {e}"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(format!("template manifest exceeds {MAX_MANIFEST_BYTES} bytes"));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "template manifest must be UTF-8".to_string())?;
    let manifest: TemplateManifest =
        toml::from_str(text).map_err(|e| format!("invalid template manifest: {e}"))?;
    let slug = manifest.template.slug.clone();
    manifest.validate(&slug)?;
    Ok(manifest)
}

fn safe_slug(value: &str, field: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(format!("{field} must be a safe lowercase identifier"))
    }
}

fn safe_method(value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        Ok(())
    } else {
        Err(format!("invalid Candid method `{value}`"))
    }
}

fn validate_placeholders(value: &str, package_names: &HashSet<&str>) -> Result<(), String> {
    let re = regex::Regex::new(r"\$\{([^}]+)\}").unwrap();
    for caps in re.captures_iter(value) {
        let token = &caps[1];
        if token != "project.name" && token != "network" {
            let Some(name) = token.strip_suffix(".canister_id") else {
                return Err(format!("unknown placeholder `${{{token}}}`"));
            };
            if !package_names.contains(name) {
                return Err(format!("placeholder references unknown package `{name}`"));
            }
        }
    }
    if re.replace_all(value, "").contains("${") {
        return Err("unterminated placeholder".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_dependency_cycles() {
        let text = r#"schema_version=1
[template]
name="Cycle"
slug="cycle"
version="1.0.0"
description="x"
category="test"
[[packages]]
name="a"
url="https://marketplace.candid.cloud/packages/auth"
depends_on=["b"]
[[packages]]
name="b"
url="https://marketplace.candid.cloud/packages/auth"
depends_on=["a"]
"#;
        let manifest: TemplateManifest = toml::from_str(text).unwrap();
        assert!(manifest.validate("cycle").unwrap_err().contains("cycle"));
    }

}
