//! Implements `#[derive(DynamicConfig)]`/`#[dynamic_config]` (see
//! `canister_hub_sdk::ic::config`'s crate-level docs, the public re-export
//! point for both, behind the `ic` feature, for the field-attribute grammar
//! and a full example) and the unrelated, decoupled `canister_metadata!`
//! (see `canister_hub_sdk::ic::metadata`'s own docs) - this file is the
//! codegen behind all of them.
//!
//! Generated code always refers to the runtime crate as `canister_hub_sdk::`
//! (not `$crate` - proc-macros can't use that hygiene trick), so anything
//! using these macros must depend on `canister-hub-sdk` under that name with
//! its `ic` feature enabled.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::parse::{Parse, ParseStream, Parser};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::{Data, DeriveInput, Fields, Ident, Lit, LitStr, Token, Type};

/// One parsed `#[config(...)]` item.
enum ConfigItem {
    Label(LitStr),
    Description(LitStr),
    Key(LitStr),
    Default(Lit),
    Secret,
    Readonly,
    Select { options: Vec<LitStr> },
    CanisterPicker { module_type: Option<LitStr> },
    CanisterType(LitStr),
}

impl Parse for ConfigItem {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let ident: Ident = input.parse()?;
        match ident.to_string().as_str() {
            "label" => {
                input.parse::<Token![=]>()?;
                Ok(ConfigItem::Label(input.parse()?))
            }
            "description" => {
                input.parse::<Token![=]>()?;
                Ok(ConfigItem::Description(input.parse()?))
            }
            "key" => {
                input.parse::<Token![=]>()?;
                Ok(ConfigItem::Key(input.parse()?))
            }
            "default" => {
                input.parse::<Token![=]>()?;
                Ok(ConfigItem::Default(input.parse()?))
            }
            "secret" => Ok(ConfigItem::Secret),
            "readonly" => Ok(ConfigItem::Readonly),
            "select" => {
                let content;
                syn::parenthesized!(content in input);
                let inner: Ident = content.parse()?;
                if inner != "options" {
                    return Err(syn::Error::new(inner.span(), "expected `options = [...]`"));
                }
                content.parse::<Token![=]>()?;
                let array;
                syn::bracketed!(array in content);
                let options: Punctuated<LitStr, Token![,]> = Punctuated::parse_terminated(&array)?;
                Ok(ConfigItem::Select {
                    options: options.into_iter().collect(),
                })
            }
            "canister_picker" => {
                if input.peek(syn::token::Paren) {
                    let content;
                    syn::parenthesized!(content in input);
                    let inner: Ident = content.parse()?;
                    if inner != "module_type" {
                        return Err(syn::Error::new(
                            inner.span(),
                            "expected `module_type = \"...\"`",
                        ));
                    }
                    content.parse::<Token![=]>()?;
                    Ok(ConfigItem::CanisterPicker {
                        module_type: Some(content.parse()?),
                    })
                } else {
                    Ok(ConfigItem::CanisterPicker { module_type: None })
                }
            }
            "canister_type" => {
                input.parse::<Token![=]>()?;
                Ok(ConfigItem::CanisterType(input.parse()?))
            }
            other => Err(syn::Error::new(
                ident.span(),
                format!("unknown `#[config(...)]` attribute `{other}`"),
            )),
        }
    }
}

#[derive(Default)]
struct FieldAttrs {
    label: Option<LitStr>,
    description: Option<LitStr>,
    key: Option<LitStr>,
    default: Option<Lit>,
    secret: bool,
    readonly: bool,
    select: Option<Vec<LitStr>>,
    canister_picker: Option<Option<LitStr>>,
    canister_type: Option<LitStr>,
}

fn parse_field_attrs(field: &syn::Field) -> syn::Result<FieldAttrs> {
    let mut attrs = FieldAttrs::default();
    for attr in &field.attrs {
        if !attr.path().is_ident("config") {
            continue;
        }
        let items: Punctuated<ConfigItem, Token![,]> =
            attr.parse_args_with(Punctuated::parse_terminated)?;
        for item in items {
            match item {
                ConfigItem::Label(v) => attrs.label = Some(v),
                ConfigItem::Description(v) => attrs.description = Some(v),
                ConfigItem::Key(v) => attrs.key = Some(v),
                ConfigItem::Default(v) => attrs.default = Some(v),
                ConfigItem::Secret => attrs.secret = true,
                ConfigItem::Readonly => attrs.readonly = true,
                ConfigItem::Select { options } => attrs.select = Some(options),
                ConfigItem::CanisterPicker { module_type } => {
                    attrs.canister_picker = Some(module_type)
                }
                ConfigItem::CanisterType(value) => attrs.canister_type = Some(value),
            }
        }
    }
    Ok(attrs)
}

/// Strips `field.ty`'s `Option<...>` wrapper, if any.
fn unwrap_option(ty: &Type) -> (bool, &Type) {
    if let Type::Path(type_path) = ty {
        if type_path.qself.is_none() {
            if let Some(segment) = type_path.path.segments.last() {
                if segment.ident == "Option" {
                    if let syn::PathArguments::AngleBracketed(args) = &segment.arguments {
                        if let Some(syn::GenericArgument::Type(inner)) = args.args.first() {
                            return (true, inner);
                        }
                    }
                }
            }
        }
    }
    (false, ty)
}

fn base_type_name(ty: &Type) -> Option<String> {
    if let Type::Path(type_path) = ty {
        if type_path.qself.is_none() {
            return type_path.path.segments.last().map(|s| s.ident.to_string());
        }
    }
    None
}

fn title_case(field_name: &str) -> String {
    field_name
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// What a field's `ConfigType` resolves to, plus whatever extra data that
/// variant carries - kept separate from `canister_hub_sdk::ic::config::ConfigType`
/// itself because this needs the still-unquoted `LitStr`s (for validating a
/// `default` against `select`'s `options`, etc.), not tokens.
enum Kind {
    Text,
    Number,
    Float,
    Boolean,
    SecretText,
    Select(Vec<LitStr>),
    CanisterPicker(Option<LitStr>),
}

fn default_literal_to_config_value(lit: &Lit, kind: &Kind) -> syn::Result<TokenStream2> {
    match kind {
        Kind::Text | Kind::SecretText => {
            let Lit::Str(s) = lit else {
                return Err(syn::Error::new(
                    lit.span(),
                    "expected a string literal default for this field",
                ));
            };
            Ok(quote! { canister_hub_sdk::ic::config::ConfigValue::Text(#s.to_string()) })
        }
        Kind::Select(options) => {
            let Lit::Str(s) = lit else {
                return Err(syn::Error::new(
                    lit.span(),
                    "expected a string literal default for this field",
                ));
            };
            let value = s.value();
            if !options.iter().any(|opt| opt.value() == value) {
                return Err(syn::Error::new(
                    s.span(),
                    format!("default `{value}` is not one of this field's `select` options"),
                ));
            }
            Ok(quote! { canister_hub_sdk::ic::config::ConfigValue::Text(#s.to_string()) })
        }
        Kind::Number => {
            let Lit::Int(i) = lit else {
                return Err(syn::Error::new(
                    lit.span(),
                    "expected an integer literal default for this field",
                ));
            };
            let value: i64 = i.base10_parse()?;
            Ok(quote! { canister_hub_sdk::ic::config::ConfigValue::Number(#value) })
        }
        Kind::Float => {
            let value: f64 = match lit {
                Lit::Float(f) => f.base10_parse()?,
                Lit::Int(i) => i.base10_parse::<i64>()? as f64,
                _ => {
                    return Err(syn::Error::new(
                        lit.span(),
                        "expected a numeric literal default for this field",
                    ))
                }
            };
            Ok(quote! { canister_hub_sdk::ic::config::ConfigValue::Float(#value) })
        }
        Kind::Boolean => {
            let Lit::Bool(b) = lit else {
                return Err(syn::Error::new(
                    lit.span(),
                    "expected a bool literal default for this field",
                ));
            };
            let value = b.value;
            Ok(quote! { canister_hub_sdk::ic::config::ConfigValue::Boolean(#value) })
        }
        Kind::CanisterPicker(_) => {
            let Lit::Str(s) = lit else {
                return Err(syn::Error::new(
                    lit.span(),
                    "expected a string literal principal (e.g. \"aaaaa-aa\") default for this field",
                ));
            };
            Ok(quote! {
                canister_hub_sdk::ic::config::ConfigValue::PrincipalId(
                    candid::Principal::from_text(#s)
                        .expect("canister_hub_sdk: invalid default principal literal")
                )
            })
        }
    }
}

/// Shared between a field's `canister_type = "..."` (what kind of canister
/// a `CanisterPicker` field expects) and a struct's `#[canister_type(...)]`
/// (what kind of canister the whole struct's canister *is*) - same four
/// values, same error either way.
fn canister_type_expr(value: &LitStr) -> syn::Result<TokenStream2> {
    match value.value().as_str() {
        "auth" => Ok(quote! { canister_hub_sdk::ic::config::CanisterType::Auth }),
        "storage" => Ok(quote! { canister_hub_sdk::ic::config::CanisterType::Storage }),
        "database" => Ok(quote! { canister_hub_sdk::ic::config::CanisterType::Database }),
        "custom" => Ok(quote! { canister_hub_sdk::ic::config::CanisterType::Custom }),
        _ => Err(syn::Error::new(
            value.span(),
            "canister_type must be one of `auth`, `storage`, `database`, or `custom`",
        )),
    }
}

/// One field's contribution: the `ConfigFieldSchema { ... }` constructor
/// tokens, plus, if it has a default, the `map.insert(...)` tokens to seed
/// `defaults()` with.
struct FieldPlan {
    schema_tokens: TokenStream2,
    default_tokens: Option<TokenStream2>,
}

fn plan_field(field: &syn::Field) -> syn::Result<FieldPlan> {
    let field_ident = field.ident.as_ref().ok_or_else(|| {
        syn::Error::new(field.span(), "dynamic_config requires named struct fields")
    })?;
    let attrs = parse_field_attrs(field)?;

    let (is_option, inner_ty) = unwrap_option(&field.ty);
    let base_name = base_type_name(inner_ty)
        .ok_or_else(|| syn::Error::new(field.ty.span(), "unsupported dynamic_config field type"))?;

    let canister_type = attrs
        .canister_type
        .as_ref()
        .map(canister_type_expr)
        .transpose()?;
    if canister_type.is_some() && base_name != "Principal" {
        return Err(syn::Error::new(
            field.ty.span(),
            "`canister_type` requires a `candid::Principal` field",
        ));
    }

    let markers = [
        attrs.secret,
        attrs.select.is_some(),
        attrs.canister_picker.is_some(),
    ]
    .iter()
    .filter(|marker| **marker)
    .count();
    if markers > 1 {
        return Err(syn::Error::new(
            field.span(),
            "`secret`, `select(...)`, and `canister_picker(...)` are mutually exclusive",
        ));
    }

    let kind = if let Some(options) = &attrs.select {
        if base_name != "String" {
            return Err(syn::Error::new(
                field.ty.span(),
                "`select(...)` requires a `String` field",
            ));
        }
        Kind::Select(options.clone())
    } else if let Some(module_type) = &attrs.canister_picker {
        if base_name != "Principal" {
            return Err(syn::Error::new(
                field.ty.span(),
                "`canister_picker` requires a `candid::Principal` field",
            ));
        }
        Kind::CanisterPicker(module_type.clone())
    } else if let Some(value) = &attrs.canister_type {
        Kind::CanisterPicker(Some(value.clone()))
    } else if attrs.secret {
        if base_name != "String" {
            return Err(syn::Error::new(
                field.ty.span(),
                "`secret` requires a `String` field",
            ));
        }
        Kind::SecretText
    } else {
        match base_name.as_str() {
            "String" => Kind::Text,
            "i64" => Kind::Number,
            "f64" => Kind::Float,
            "bool" => Kind::Boolean,
            "Principal" => Kind::CanisterPicker(None),
            other => {
                return Err(syn::Error::new(
                    field.ty.span(),
                    format!(
                        "unsupported dynamic_config field type `{other}` - use String, i64, f64, \
                         bool, candid::Principal, or Option<...> of one of those"
                    ),
                ))
            }
        }
    };

    let field_type_tokens = match &kind {
        Kind::Text => quote! { canister_hub_sdk::ic::config::ConfigType::Text },
        Kind::Number => quote! { canister_hub_sdk::ic::config::ConfigType::Number },
        Kind::Float => quote! { canister_hub_sdk::ic::config::ConfigType::Float },
        Kind::Boolean => quote! { canister_hub_sdk::ic::config::ConfigType::Boolean },
        Kind::SecretText => quote! { canister_hub_sdk::ic::config::ConfigType::SecretText },
        Kind::Select(options) => {
            quote! { canister_hub_sdk::ic::config::ConfigType::Select { options: vec![#(#options.to_string()),*] } }
        }
        Kind::CanisterPicker(module_type) => {
            let filter = match module_type {
                Some(lit) => quote! { Some(#lit.to_string()) },
                None => quote! { None },
            };
            quote! { canister_hub_sdk::ic::config::ConfigType::CanisterPicker { module_type_filter: #filter } }
        }
    };

    let key_lit = match &attrs.key {
        Some(lit) => lit.value(),
        None => field_ident.to_string(),
    };
    let label_lit = match &attrs.label {
        Some(lit) => lit.value(),
        None => title_case(&field_ident.to_string()),
    };
    let description_lit = attrs
        .description
        .as_ref()
        .map(|lit| lit.value())
        .unwrap_or_default();

    let default_value_tokens = match &attrs.default {
        Some(lit) => Some(default_literal_to_config_value(lit, &kind)?),
        None => None,
    };

    // Read-only values are supplied by canister code, not by the settings
    // client, so they must never make a public set_config call impossible.
    let is_required = !attrs.readonly && !is_option && attrs.default.is_none();
    let is_readonly = attrs.readonly;

    let default_value_field = match &default_value_tokens {
        Some(tokens) => quote! { Some(#tokens) },
        None => quote! { None },
    };
    let canister_type_field = match canister_type {
        Some(value) => quote! { Some(#value) },
        None => quote! { None },
    };

    let schema_tokens = quote! {
        canister_hub_sdk::ic::config::ConfigFieldSchema {
            key: #key_lit.to_string(),
            label: #label_lit.to_string(),
            description: #description_lit.to_string(),
            field_type: #field_type_tokens,
            canister_type: #canister_type_field,
            is_required: #is_required,
            is_readonly: Some(#is_readonly),
            default_value: #default_value_field,
        }
    };

    let default_tokens =
        default_value_tokens.map(|tokens| quote! { map.insert(#key_lit.to_string(), #tokens); });

    Ok(FieldPlan {
        schema_tokens,
        default_tokens,
    })
}

/// One parsed `#[config_urls(...)]` item (a struct-level attribute, unlike
/// `#[config(...)]`'s field-level one).
enum ConfigUrlsItem {
    AdminPanelUrl(LitStr),
    HomePageUrl(LitStr),
}

impl Parse for ConfigUrlsItem {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let ident: Ident = input.parse()?;
        input.parse::<Token![=]>()?;
        match ident.to_string().as_str() {
            "admin_panel_url" => Ok(ConfigUrlsItem::AdminPanelUrl(input.parse()?)),
            "home_page_url" => Ok(ConfigUrlsItem::HomePageUrl(input.parse()?)),
            other => Err(syn::Error::new(
                ident.span(),
                format!("unknown `#[config_urls(...)]` attribute `{other}`"),
            )),
        }
    }
}

#[derive(Default)]
struct ConfigUrls {
    admin_panel_url: Option<LitStr>,
    home_page_url: Option<LitStr>,
}

fn parse_config_urls(attrs: &[syn::Attribute]) -> syn::Result<ConfigUrls> {
    let mut urls = ConfigUrls::default();
    for attr in attrs {
        if !attr.path().is_ident("config_urls") {
            continue;
        }
        let items: Punctuated<ConfigUrlsItem, Token![,]> =
            attr.parse_args_with(Punctuated::parse_terminated)?;
        for item in items {
            match item {
                ConfigUrlsItem::AdminPanelUrl(v) => urls.admin_panel_url = Some(v),
                ConfigUrlsItem::HomePageUrl(v) => urls.home_page_url = Some(v),
            }
        }
    }
    Ok(urls)
}

/// `None` (no URL declared) or
/// `Some(canister_hub_sdk::ic::config::resolve_url_template(<literal>))` -
/// the runtime substitutes `{canister_id}` in the literal with this
/// canister's own principal, so one static string can point at a path on
/// the canister itself (e.g. `"https://{canister_id}.icp0.io/admin"`).
fn url_expr(lit: &Option<LitStr>) -> TokenStream2 {
    match lit {
        Some(lit) => quote! { Some(canister_hub_sdk::ic::config::resolve_url_template(#lit)) },
        None => quote! { None },
    }
}

fn expand(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let struct_ident = &input.ident;
    let fields = match &input.data {
        Data::Struct(data) => match &data.fields {
            Fields::Named(named) => &named.named,
            _ => {
                return Err(syn::Error::new(
                    input.span(),
                    "dynamic_config requires a struct with named fields",
                ))
            }
        },
        _ => {
            return Err(syn::Error::new(
                input.span(),
                "dynamic_config can only be used on a struct",
            ))
        }
    };

    let mut schema_entries = Vec::new();
    let mut default_entries = Vec::new();
    for field in fields {
        let plan = plan_field(field)?;
        schema_entries.push(plan.schema_tokens);
        if let Some(tokens) = plan.default_tokens {
            default_entries.push(tokens);
        }
    }

    let urls = parse_config_urls(&input.attrs)?;
    let admin_panel_expr = url_expr(&urls.admin_panel_url);
    let home_page_expr = url_expr(&urls.home_page_url);

    Ok(quote! {
        impl canister_hub_sdk::ic::config::ConfigSchema for #struct_ident {
            fn schema() -> Vec<canister_hub_sdk::ic::config::ConfigFieldSchema> {
                vec![ #(#schema_entries),* ]
            }

            fn defaults() -> std::collections::HashMap<String, canister_hub_sdk::ic::config::ConfigValue> {
                let mut map = std::collections::HashMap::new();
                #(#default_entries)*
                map
            }
        }

        #[ic_cdk::query]
        fn get_config_schema() -> Vec<canister_hub_sdk::ic::config::ConfigFieldSchema> {
            <#struct_ident as canister_hub_sdk::ic::config::ConfigSchema>::schema()
        }

        #[ic_cdk::query]
        fn get_config() -> std::collections::HashMap<String, canister_hub_sdk::ic::config::ConfigValue> {
            canister_hub_sdk::ic::config::get::<#struct_ident>()
        }

        #[ic_cdk::update]
        fn set_config(
            new_settings: std::collections::HashMap<String, canister_hub_sdk::ic::config::ConfigValue>,
        ) -> Result<(), String> {
            if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
                return Err("only a controller may change configuration".to_string());
            }
            canister_hub_sdk::ic::config::set::<#struct_ident>(new_settings)
        }

        #[ic_cdk::query]
        fn get_admin_panel_url() -> Option<String> {
            #admin_panel_expr
        }

        #[ic_cdk::query]
        fn get_home_page_url() -> Option<String> {
            #home_page_expr
        }
    })
}

/// See `canister_hub_sdk::ic::config::DynamicConfig`'s docs for the
/// field-attribute grammar and the optional struct-level
/// `#[config_urls(...)]`.
#[proc_macro_derive(DynamicConfig, attributes(config, config_urls))]
pub fn derive_dynamic_config(input: TokenStream) -> TokenStream {
    let input = syn::parse_macro_input!(input as DeriveInput);
    match expand(&input) {
        Ok(tokens) => tokens.into(),
        Err(err) => err.to_compile_error().into(),
    }
}

fn strip_founder_os_attrs(input: &mut DeriveInput) {
    input
        .attrs
        .retain(|attr| !attr.path().is_ident("config_urls"));
    if let Data::Struct(data) = &mut input.data {
        if let Fields::Named(named) = &mut data.fields {
            for field in named.named.iter_mut() {
                field.attrs.retain(|attr| !attr.path().is_ident("config"));
            }
        }
    }
}

/// See `canister_hub_sdk::ic::config::dynamic_config`'s docs for the
/// field-attribute grammar and the optional struct-level
/// `#[config_urls(...)]`. Unlike the derive form, this also adds
/// `#[derive(candid::CandidType, serde::Deserialize, Clone, Debug)]` to the
/// struct and strips the (otherwise-unrecognized outside a derive macro)
/// `#[config(...)]`/`#[config_urls(...)]` attributes before re-emitting it.
#[proc_macro_attribute]
pub fn dynamic_config(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let mut input = syn::parse_macro_input!(item as DeriveInput);
    let generated = match expand(&input) {
        Ok(tokens) => tokens,
        Err(err) => return err.to_compile_error().into(),
    };
    strip_founder_os_attrs(&mut input);
    let output = quote! {
        #[derive(candid::CandidType, serde::Deserialize, Clone, Debug)]
        #input
        #generated
    };
    output.into()
}

/// One parsed `canister_metadata!(...)` item.
enum MetadataItem {
    Name(LitStr),
    Description(LitStr),
    CanisterType(LitStr),
    Version(LitStr),
}

impl Parse for MetadataItem {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let ident: Ident = input.parse()?;
        input.parse::<Token![=]>()?;
        match ident.to_string().as_str() {
            "name" => Ok(MetadataItem::Name(input.parse()?)),
            "description" => Ok(MetadataItem::Description(input.parse()?)),
            "canister_type" => Ok(MetadataItem::CanisterType(input.parse()?)),
            "version" => Ok(MetadataItem::Version(input.parse()?)),
            other => Err(syn::Error::new(
                ident.span(),
                format!("unknown `canister_metadata!(...)` argument `{other}` - expected `name`, `description`, `canister_type`, or `version`"),
            )),
        }
    }
}

/// See `canister_hub_sdk::ic::metadata`'s own docs for the full grammar -
/// `name` is required; `description`, `canister_type`, and `version` are
/// optional (default to `""`, `None`, and the calling crate's own
/// `CARGO_PKG_VERSION`, respectively).
#[proc_macro]
pub fn canister_metadata(input: TokenStream) -> TokenStream {
    let items = match Punctuated::<MetadataItem, Token![,]>::parse_terminated.parse(input) {
        Ok(items) => items,
        Err(err) => return err.to_compile_error().into(),
    };

    let mut name: Option<LitStr> = None;
    let mut description: Option<LitStr> = None;
    let mut canister_type: Option<LitStr> = None;
    let mut version: Option<LitStr> = None;
    for item in items {
        let (slot, value, label): (&mut Option<LitStr>, LitStr, &str) = match item {
            MetadataItem::Name(v) => (&mut name, v, "name"),
            MetadataItem::Description(v) => (&mut description, v, "description"),
            MetadataItem::CanisterType(v) => (&mut canister_type, v, "canister_type"),
            MetadataItem::Version(v) => (&mut version, v, "version"),
        };
        if slot.is_some() {
            return syn::Error::new(value.span(), format!("`{label}` may only be given once"))
                .to_compile_error()
                .into();
        }
        *slot = Some(value);
    }

    let name = match name {
        Some(v) => v,
        None => {
            return syn::Error::new(
                proc_macro2::Span::call_site(),
                "canister_metadata! requires `name = \"...\"`",
            )
            .to_compile_error()
            .into();
        }
    };
    let description_expr = match description {
        Some(v) => quote! { #v.to_string() },
        None => quote! { String::new() },
    };
    let canister_type_expr = match canister_type.as_ref().map(canister_type_expr).transpose() {
        Ok(Some(variant)) => quote! { Some(#variant) },
        Ok(None) => quote! { None },
        Err(err) => return err.to_compile_error().into(),
    };
    let version_expr = match version {
        Some(v) => quote! { #v.to_string() },
        None => quote! { env!("CARGO_PKG_VERSION").to_string() },
    };

    quote! {
        #[ic_cdk::query]
        fn canister_metadata() -> canister_hub_sdk::ic::metadata::CanisterMetadata {
            canister_hub_sdk::ic::metadata::CanisterMetadata {
                name: #name.to_string(),
                description: #description_expr,
                canister_type: #canister_type_expr,
                version: #version_expr,
            }
        }
    }
    .into()
}
