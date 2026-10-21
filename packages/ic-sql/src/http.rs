//! PostgREST-style HTTP gateway for the stable SQL database, plus (for any
//! request outside it) the embedded `table-browser` static UI - see
//! `assets.rs`.
//!
//! Supported collection route: `/rest/v1/{table}`. Public GETs can remain IC
//! queries. Every RLS-protected request is upgraded so its bearer session can
//! be verified by the auth canister before any row is read or changed.

use crate::auth::PermissionLevel;
use crate::engine::{ColumnDef, QueryResult, SqlValue};
use crate::rls::AuthContext;
use crate::storage;
use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type HeaderField = (String, String);

const REST_PREFIX: &str = "/rest/v1/";
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_PAGE_SIZE: usize = 500;
const DEFAULT_PAGE_SIZE: usize = 100;

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub upgrade: Option<bool>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
    details: Option<&'a str>,
    hint: Option<&'a str>,
}

impl HttpResponse {
    fn json(status_code: u16, value: &impl Serialize) -> Self {
        match serde_json::to_vec(value) {
            Ok(body) => Self {
                status_code,
                headers: cors_headers("application/json; charset=utf-8"),
                body,
                upgrade: None,
            },
            Err(error) => Self::error(
                500,
                "ICPDB500",
                &format!("failed to encode response: {error}"),
            ),
        }
    }

    fn json_with_headers(
        status_code: u16,
        value: &impl Serialize,
        headers: Vec<HeaderField>,
    ) -> Self {
        let mut response = Self::json(status_code, value);
        response.headers.extend(headers);
        response
    }

    fn empty(status_code: u16) -> Self {
        Self {
            status_code,
            headers: cors_headers("application/json; charset=utf-8"),
            body: Vec::new(),
            upgrade: None,
        }
    }

    fn error(status_code: u16, code: &'static str, message: &str) -> Self {
        Self::json(
            status_code,
            &ErrorBody {
                code,
                message,
                details: None,
                hint: None,
            },
        )
    }

    fn upgrade() -> Self {
        Self {
            status_code: 200,
            headers: Vec::new(),
            body: Vec::new(),
            upgrade: Some(true),
        }
    }
}

fn cors_headers(content_type: &str) -> Vec<HeaderField> {
    vec![
        ("content-type".to_string(), content_type.to_string()),
        ("access-control-allow-origin".to_string(), "*".to_string()),
        (
            "access-control-allow-methods".to_string(),
            "GET, HEAD, POST, PATCH, DELETE, OPTIONS".to_string(),
        ),
        (
            "access-control-allow-headers".to_string(),
            "authorization, apikey, content-type, prefer, range".to_string(),
        ),
        (
            "access-control-expose-headers".to_string(),
            "content-range, preference-applied".to_string(),
        ),
    ]
}

fn path_and_query(url: &str) -> (&str, &str) {
    url.split_once('?').unwrap_or((url, ""))
}

fn header<'a>(headers: &'a [HeaderField], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn wants_representation(headers: &[HeaderField]) -> bool {
    header(headers, "prefer").is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("return=representation"))
    })
}

fn bearer_token(headers: &[HeaderField]) -> Result<String, String> {
    let value = header(headers, "authorization")
        .ok_or_else(|| "missing Authorization header".to_string())?;
    let (scheme, token) = value
        .split_once(' ')
        .ok_or_else(|| "Authorization must be 'Bearer <session-token>'".to_string())?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() || token.contains(' ') {
        return Err("Authorization must be 'Bearer <session-token>'".to_string());
    }
    Ok(token.to_string())
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .map_err(|_| "invalid percent encoding")?;
                output.push(u8::from_str_radix(hex, 16).map_err(|_| "invalid percent encoding")?);
                index += 3;
            }
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(output).map_err(|_| "URL contains invalid UTF-8".to_string())
}

fn query_pairs(query: &str) -> Result<Vec<(String, String)>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    query
        .split('&')
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            Ok((percent_decode(key)?, percent_decode(value)?))
        })
        .collect()
}

fn valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('_') | Some('a'..='z') | Some('A'..='Z'))
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn table_from_path(path: &str) -> Result<Option<String>, String> {
    let Some(encoded) = path.strip_prefix(REST_PREFIX) else {
        return Ok(None);
    };
    if encoded.is_empty() || encoded.contains('/') {
        return Err("expected /rest/v1/{table}".to_string());
    }
    let table = percent_decode(encoded)?.to_lowercase();
    if !valid_identifier(&table) {
        return Err("invalid table name".to_string());
    }
    Ok(Some(table))
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn column<'a>(columns: &'a [ColumnDef], name: &str) -> Result<&'a ColumnDef, String> {
    if !valid_identifier(name) {
        return Err(format!("invalid column name '{name}'"));
    }
    columns
        .iter()
        .find(|column| column.name == name)
        .ok_or_else(|| format!("unknown column '{name}'"))
}

fn json_sql_literal(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok("NULL".to_string()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => Ok(sql_string(value)),
        _ => Err("cell values must be JSON null, boolean, number, or string".to_string()),
    }
}

fn filter_sql_literal(value: &str, data_type: &str) -> String {
    if value.eq_ignore_ascii_case("null") {
        return "NULL".to_string();
    }
    let data_type = data_type.to_ascii_uppercase();
    let scalar_type = ["INT", "REAL", "FLOAT", "DOUBLE", "NUMERIC", "BOOL"]
        .iter()
        .any(|kind| data_type.contains(kind));
    if scalar_type
        && (value.parse::<f64>().is_ok()
            || value.eq_ignore_ascii_case("true")
            || value.eq_ignore_ascii_case("false"))
    {
        value.to_ascii_lowercase()
    } else {
        sql_string(value)
    }
}

fn filters_and_page(
    query: &str,
    columns: &[ColumnDef],
) -> Result<(String, usize, usize, Vec<String>, String), String> {
    let mut filters = Vec::new();
    let mut limit = DEFAULT_PAGE_SIZE;
    let mut offset = 0;
    let mut selected = columns
        .iter()
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();
    let mut order_by = String::new();
    for (key, value) in query_pairs(query)? {
        match key.as_str() {
            "select" => {
                if value != "*" {
                    selected = value.split(',').map(|name| name.to_lowercase()).collect();
                    for name in &selected {
                        column(columns, name)?;
                    }
                }
            }
            "limit" => {
                limit = value
                    .parse::<usize>()
                    .map_err(|_| "limit must be a non-negative integer")?
                    .min(MAX_PAGE_SIZE);
            }
            "offset" => {
                offset = value
                    .parse::<usize>()
                    .map_err(|_| "offset must be a non-negative integer")?
            }
            "order" => {
                let mut terms = Vec::new();
                for term in value.split(',') {
                    let mut parts = term.split('.');
                    let name = parts.next().unwrap_or_default().to_lowercase();
                    column(columns, &name)?;
                    let mut direction = "ASC";
                    let mut nulls = "";
                    for modifier in parts {
                        match modifier.to_ascii_lowercase().as_str() {
                            "asc" => direction = "ASC",
                            "desc" => direction = "DESC",
                            "nullsfirst" => nulls = " NULLS FIRST",
                            "nullslast" => nulls = " NULLS LAST",
                            _ => return Err(format!("unsupported order modifier '{modifier}'")),
                        }
                    }
                    terms.push(format!("{name} {direction}{nulls}"));
                }
                if terms.is_empty() {
                    return Err("order must contain at least one column".to_string());
                }
                order_by = format!(" ORDER BY {}", terms.join(", "));
            }
            name => {
                let name = name.to_lowercase();
                let definition = column(columns, &name)?;
                let (operator, raw_value) = value.split_once('.').ok_or_else(|| {
                    format!("filter '{name}' must use operator.value, for example {name}=eq.42")
                })?;
                let sql_operator = match operator {
                    "eq" => "=",
                    "neq" => "!=",
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    "lte" => "<=",
                    _ => return Err(format!("unsupported filter operator '{operator}'")),
                };
                filters.push(format!(
                    "{name} {sql_operator} {}",
                    filter_sql_literal(raw_value, &definition.data_type)
                ));
            }
        }
    }
    Ok((filters.join(" AND "), limit, offset, selected, order_by))
}

fn sql_value_json(value: &SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(value) => Value::from(*value),
        SqlValue::Float(value) => {
            serde_json::Number::from_f64(*value).map_or(Value::Null, Value::Number)
        }
        SqlValue::Text(value) => Value::String(value.clone()),
        SqlValue::Boolean(value) => Value::Bool(*value),
    }
}

fn rows_json(result: &QueryResult) -> Vec<Value> {
    result
        .rows
        .iter()
        .map(|row| {
            Value::Object(
                result
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(index, name)| {
                        (
                            name.clone(),
                            row.get(index).map_or(Value::Null, sql_value_json),
                        )
                    })
                    .collect(),
            )
        })
        .collect()
}

fn select_rows(
    table: &str,
    query: &str,
    context: Option<&AuthContext>,
) -> Result<(Vec<Value>, usize, usize), String> {
    let description = storage::describe_table(table)?;
    let (filters, limit, offset, selected, order_by) =
        filters_and_page(query, &description.columns)?;
    let projection = selected.join(", ");
    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        format!(" WHERE {filters}")
    };
    let sql = format!("SELECT {projection} FROM {table}{where_clause}{order_by}");
    let (_, result) = crate::apply_sql(
        &storage::load_database_for_query(&sql),
        &sql,
        context,
        false,
    )?;
    let total = result.rows.len();
    let rows = rows_json(&result)
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();
    Ok((rows, total, offset))
}

fn mutation_response(
    result: QueryResult,
    representation: Option<Vec<Value>>,
    prefer: bool,
    minimal_status: u16,
    representation_status: u16,
) -> HttpResponse {
    if prefer {
        let mut response =
            HttpResponse::json(representation_status, &representation.unwrap_or_default());
        response.headers.push((
            "preference-applied".to_string(),
            "return=representation".to_string(),
        ));
        response
    } else {
        let mut response = HttpResponse::empty(minimal_status);
        response.headers.push((
            "x-rows-affected".to_string(),
            result.rows_affected.to_string(),
        ));
        response
    }
}

fn normalize_object(object: Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut normalized = Map::new();
    for (name, value) in object {
        let name = name.to_lowercase();
        if normalized.insert(name.clone(), value).is_some() {
            return Err(format!(
                "duplicate column '{name}' after case normalization"
            ));
        }
    }
    Ok(normalized)
}

fn insert_sql(table: &str, body: &[u8]) -> Result<(String, Vec<Value>), String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|error| format!("invalid JSON body: {error}"))?;
    let objects = match value {
        Value::Object(object) => vec![normalize_object(object)?],
        Value::Array(values) if !values.is_empty() => values
            .into_iter()
            .map(|value| match value {
                Value::Object(object) => normalize_object(object),
                _ => Err("insert array must contain only JSON objects".to_string()),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Value::Array(_) => return Err("insert array must not be empty".to_string()),
        _ => return Err("insert body must be a JSON object or array of objects".to_string()),
    };
    let description = storage::describe_table(table)?;
    for object in &objects {
        for name in object.keys() {
            column(&description.columns, name)?;
        }
    }
    let column_names = description
        .columns
        .iter()
        .filter(|column| {
            objects
                .iter()
                .any(|object| object.contains_key(&column.name))
        })
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();
    if column_names.is_empty() {
        return Err("insert body must contain at least one column".to_string());
    }
    let value_rows = objects
        .iter()
        .map(|object| {
            column_names
                .iter()
                .map(|name| json_sql_literal(object.get(name).unwrap_or(&Value::Null)))
                .collect::<Result<Vec<_>, _>>()
                .map(|values| format!("({})", values.join(", ")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let representation = objects.into_iter().map(Value::Object).collect();
    Ok((
        format!(
            "INSERT INTO {table} ({}) VALUES {}",
            column_names.join(", "),
            value_rows.join(", ")
        ),
        representation,
    ))
}

fn update_sql(table: &str, query: &str, body: &[u8]) -> Result<String, String> {
    let values: Map<String, Value> =
        serde_json::from_slice(body).map_err(|error| format!("invalid JSON body: {error}"))?;
    let values = normalize_object(values)?;
    if values.is_empty() {
        return Err("update body must not be empty".to_string());
    }
    let description = storage::describe_table(table)?;
    let (filters, _, _, _, _) = filters_and_page(query, &description.columns)?;
    let assignments = values
        .iter()
        .map(|(name, value)| {
            column(&description.columns, name)?;
            Ok(format!("{name} = {}", json_sql_literal(value)?))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        format!(" WHERE {filters}")
    };
    Ok(format!(
        "UPDATE {table} SET {}{where_clause}",
        assignments.join(", ")
    ))
}

fn delete_sql(table: &str, query: &str) -> Result<String, String> {
    let description = storage::describe_table(table)?;
    let (filters, _, _, _, _) = filters_and_page(query, &description.columns)?;
    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        format!(" WHERE {filters}")
    };
    Ok(format!("DELETE FROM {table}{where_clause}"))
}

fn execute_mutation(sql: &str, context: Option<&AuthContext>) -> Result<QueryResult, String> {
    let old_database = storage::load_database();
    let (new_database, result) = crate::apply_sql(&old_database, sql, context, false)?;
    storage::commit_database(&old_database, &new_database);
    Ok(result)
}

fn read_response(
    method: &str,
    table: &str,
    query: &str,
    context: Option<&AuthContext>,
) -> HttpResponse {
    match select_rows(table, query, context) {
        Ok((rows, total, offset)) => {
            let content_range = if rows.is_empty() {
                format!("*/{total}")
            } else {
                let end = offset + rows.len() - 1;
                format!("{offset}-{end}/{total}")
            };
            let headers = vec![("content-range".to_string(), content_range)];
            if method == "HEAD" {
                let mut response = HttpResponse::empty(200);
                response.headers.extend(headers);
                response
            } else {
                HttpResponse::json_with_headers(200, &rows, headers)
            }
        }
        Err(error) => HttpResponse::error(400, "PGRST100", &error),
    }
}

pub fn query(request: HttpRequest) -> HttpResponse {
    let method = request.method.to_ascii_uppercase();
    let (path, query) = path_and_query(&request.url);
    if method == "OPTIONS" {
        return HttpResponse {
            status_code: 204,
            headers: cors_headers("application/json; charset=utf-8"),
            body: Vec::new(),
            upgrade: None,
        };
    }
    // Everything outside the REST gateway is the embedded table-browser UI
    // (see `assets.rs`) - its static files, served straight from this same
    // canister, no separate asset canister or CORS hop needed.
    if !path.starts_with(REST_PREFIX) {
        return crate::assets::serve(&request);
    }
    if path == "/rest/v1/" && method == "GET" {
        if storage::get_permission(&candid::Principal::anonymous())
            == Some(PermissionLevel::Blocked)
        {
            return HttpResponse::error(403, "PGRST301", "anonymous REST access is blocked");
        }
        return HttpResponse::json(200, &storage::list_tables());
    }
    let table = match table_from_path(path) {
        Ok(Some(table)) => table,
        Ok(None) => return HttpResponse::error(404, "PGRST404", "route not found"),
        Err(error) => return HttpResponse::error(400, "PGRST100", &error),
    };
    match method.as_str() {
        "GET" | "HEAD" => {
            if storage::get_rls_policy(&table).is_some() {
                return HttpResponse::upgrade();
            }
            if storage::get_permission(&candid::Principal::anonymous())
                == Some(PermissionLevel::Blocked)
            {
                return HttpResponse::error(403, "PGRST301", "anonymous REST access is blocked");
            }
            read_response(&method, &table, query, None)
        }
        "POST" | "PATCH" | "DELETE" => HttpResponse::upgrade(),
        _ => HttpResponse::error(405, "PGRST405", "method not allowed"),
    }
}

pub async fn update(request: HttpRequest) -> HttpResponse {
    if request.body.len() > MAX_BODY_BYTES {
        return HttpResponse::error(413, "PGRST102", "request body exceeds 1 MiB");
    }
    let method = request.method.to_ascii_uppercase();
    let (path, query) = path_and_query(&request.url);
    if !path.starts_with(REST_PREFIX) {
        return crate::assets::serve(&request);
    }
    let table = match table_from_path(path) {
        Ok(Some(table)) => table,
        Ok(None) => return HttpResponse::error(404, "PGRST404", "route not found"),
        Err(error) => return HttpResponse::error(400, "PGRST100", &error),
    };
    let rls_enabled = storage::get_rls_policy(&table).is_some();
    let context = if rls_enabled {
        let token = match bearer_token(&request.headers) {
            Ok(token) => token,
            Err(error) => return HttpResponse::error(401, "PGRST302", &error),
        };
        match crate::authenticate_session(token).await {
            Ok(context) => Some(context),
            Err(error) => return HttpResponse::error(401, "PGRST302", &error),
        }
    } else {
        None
    };

    let permission = match context.as_ref() {
        Some(context) => crate::permission_for_verified_identity(context),
        None => crate::resolve_permission(candid::Principal::anonymous()).await,
    };
    if permission == PermissionLevel::Blocked {
        return HttpResponse::error(403, "PGRST301", "REST access is blocked");
    }
    if matches!(method.as_str(), "GET" | "HEAD") {
        return read_response(&method, &table, query, context.as_ref());
    }
    match permission {
        PermissionLevel::ReadWrite => {}
        PermissionLevel::ReadOnly => {
            let message = if rls_enabled {
                "authenticated identity has read-only access"
            } else {
                "anonymous REST writes require an explicit ReadWrite permission"
            };
            return HttpResponse::error(403, "PGRST301", message);
        }
        PermissionLevel::Blocked => unreachable!(),
    }
    let prefer = wants_representation(&request.headers);
    let outcome = match method.as_str() {
        "POST" => insert_sql(&table, &request.body).and_then(|(sql, representation)| {
            execute_mutation(&sql, context.as_ref())
                .map(|result| mutation_response(result, Some(representation), prefer, 201, 201))
        }),
        "PATCH" => update_sql(&table, query, &request.body).and_then(|sql| {
            execute_mutation(&sql, context.as_ref()).and_then(|result| {
                let representation = if prefer {
                    Some(select_rows(&table, query, context.as_ref())?.0)
                } else {
                    None
                };
                Ok(mutation_response(result, representation, prefer, 204, 200))
            })
        }),
        "DELETE" => {
            let representation = if prefer {
                match select_rows(&table, query, context.as_ref()) {
                    Ok((rows, _, _)) => Some(rows),
                    Err(error) => return HttpResponse::error(400, "PGRST100", &error),
                }
            } else {
                None
            };
            delete_sql(&table, query).and_then(|sql| {
                execute_mutation(&sql, context.as_ref())
                    .map(|result| mutation_response(result, representation, prefer, 204, 200))
            })
        }
        _ => return HttpResponse::error(405, "PGRST405", "method not allowed"),
    };
    match outcome {
        Ok(response) => response,
        Err(error) => HttpResponse::error(400, "PGRST100", &error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine;

    #[test]
    fn parses_postgrest_filters_and_pagination() {
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                data_type: "INT".to_string(),
            },
            ColumnDef {
                name: "name".to_string(),
                data_type: "TEXT".to_string(),
            },
        ];
        let (filters, limit, offset, selected, order_by) = filters_and_page(
            "select=id,name&id=gte.2&name=neq.a%20b&limit=20&offset=4&order=name.desc.nullslast",
            &columns,
        )
        .unwrap();
        assert_eq!(filters, "id >= 2 AND name != 'a b'");
        assert_eq!((limit, offset), (20, 4));
        assert_eq!(selected, vec!["id", "name"]);
        assert_eq!(order_by, " ORDER BY name DESC NULLS LAST");
    }

    #[test]
    fn rejects_identifiers_and_unknown_operators() {
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            data_type: "INT".to_string(),
        }];
        assert!(table_from_path("/rest/v1/users;DROP").is_err());
        assert!(filters_and_page("id=in.(1,2)", &columns).is_err());
        assert!(filters_and_page("unknown=eq.1", &columns).is_err());
    }

    #[test]
    fn converts_query_results_to_json_objects() {
        let result = QueryResult {
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![vec![
                SqlValue::Integer(1),
                SqlValue::Text("alice".to_string()),
            ]],
            rows_affected: 1,
            message: String::new(),
        };
        assert_eq!(
            rows_json(&result),
            vec![serde_json::json!({"id": 1, "name": "alice"})]
        );
    }

    #[test]
    fn rest_crud_builders_round_trip_through_stable_storage() {
        let empty = storage::load_database();
        let (database, _) =
            engine::apply(&empty, "CREATE TABLE rest_users (id INT, name TEXT)").unwrap();
        storage::commit_database(&empty, &database);

        let (sql, _) = insert_sql(
            "rest_users",
            br#"[{"id":1,"name":"alice"},{"id":2,"name":"bob"}]"#,
        )
        .unwrap();
        assert_eq!(execute_mutation(&sql, None).unwrap().rows_affected, 2);

        let response = query(HttpRequest {
            method: "GET".to_string(),
            url: "/rest/v1/rest_users?select=id,name&id=gte.2".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        });
        assert_eq!(response.status_code, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&response.body).unwrap(),
            serde_json::json!([{"id": 2, "name": "bob"}])
        );

        let sql = update_sql("rest_users", "id=eq.2", br#"{"name":"robert"}"#).unwrap();
        assert_eq!(execute_mutation(&sql, None).unwrap().rows_affected, 1);
        let (rows, _, _) = select_rows("rest_users", "id=eq.2", None).unwrap();
        assert_eq!(rows, vec![serde_json::json!({"id": 2, "name": "robert"})]);

        let sql = delete_sql("rest_users", "id=eq.1").unwrap();
        assert_eq!(execute_mutation(&sql, None).unwrap().rows_affected, 1);
        assert_eq!(storage::describe_table("rest_users").unwrap().row_count, 1);
    }

    #[test]
    fn protected_rest_reads_upgrade_before_touching_rows() {
        let empty = storage::load_database();
        let (database, _) = engine::apply(
            &empty,
            "CREATE TABLE rest_rls_upgrade (owner_id TEXT, value TEXT)",
        )
        .unwrap();
        storage::commit_database(&empty, &database);
        storage::set_rls_policy(crate::RlsPolicy {
            table_name: "rest_rls_upgrade".to_string(),
            owner_column: "owner_id".to_string(),
        });

        let response = query(HttpRequest {
            method: "GET".to_string(),
            url: "/rest/v1/rest_rls_upgrade".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        });
        assert_eq!(response.upgrade, Some(true));
    }

    #[test]
    fn bearer_parser_requires_exactly_one_token() {
        let headers = vec![(
            "Authorization".to_string(),
            "Bearer token-without-spaces".to_string(),
        )];
        assert_eq!(bearer_token(&headers).unwrap(), "token-without-spaces");
        assert!(bearer_token(&[(
            "Authorization".to_string(),
            "Bearer token extra".to_string()
        )])
        .is_err());
    }
}
