//! The functional core of ic-sql: pure, deterministic SQL execution over an
//! immutable in-memory [`Database`] value.
//!
//! Nothing in this module touches a `thread_local`, calls into `ic_cdk`, or
//! reads/writes any other hidden state - every function here is a pure
//! transformation from its arguments to its return value. In particular,
//! [`apply`] is the single entry point the rest of the canister needs: given
//! the same `db` and the same `sql`, it always returns the same
//! `(Database, QueryResult)` pair, and never modifies the `db` it was given -
//! a mutation "changes" the database by handing back a *new* `Database`
//! value, the old one left exactly as it was. That's what "functional" means
//! here in a concrete, checkable sense, not just a name - and it's what makes
//! this module fully testable with plain `cargo test`, no canister runtime or
//! Wasm build required (see the tests below).
//!
//! One consequence worth calling out: this makes every statement atomic for
//! free. `DROP TABLE a, b` where `b` doesn't exist can't leave `a` dropped
//! anyway - each `apply_*` function below builds its *entire* new `Database`
//! before returning `Ok`, so an `Err` partway through means the function
//! returns before constructing (let alone returning) any new value at all,
//! and the original `db` is untouched.
//!
//! [`Database`]/[`Table`] are backed by [`im`]'s persistent (structurally
//! shared) maps rather than `std::collections::BTreeMap`: `.clone()`ing one,
//! or inserting/removing an entry on a clone, is `O(log n)` and shares all
//! unaffected structure with the original - not a deep copy. That's what lets
//! `apply_insert`/`apply_delete`/etc. below write in the straightforward
//! "clone, then modify the clone" style without it meaning "copy the whole
//! table on every write."

use candid::CandidType;
use im::OrdMap;
use serde::{Deserialize, Serialize};
use sqlparser::ast::{
    AlterColumnOperation, AlterTableOperation, ColumnOption, Delete, Expr, FromTable, FunctionArg,
    FunctionArgExpr, FunctionArguments, GroupByExpr, JoinConstraint, JoinOperator, LimitClause,
    ObjectType, OrderByKind, ReferentialAction, SelectItem, SetExpr, Statement,
    TableConstraint as AstTableConstraint, TableFactor, Value as SqlParserValue, Values,
};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;
use std::cmp::Ordering;

// ============================================================================
// Values
// ============================================================================

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Float(f64),
    Text(String),
    Boolean(bool),
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct Row {
    pub values: Vec<SqlValue>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
    pub rows_affected: u64,
    pub message: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct TableDescription {
    pub name: String,
    pub columns: Vec<ColumnDef>,
    pub row_count: u64,
}

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize, PartialEq)]
pub struct RelationalConstraints {
    pub not_null: Vec<String>,
    pub unique: Vec<UniqueConstraint>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyConstraint>,
    #[serde(default)]
    pub defaults: Vec<ColumnDefault>,
    #[serde(default)]
    pub checks: Vec<CheckConstraint>,
    #[serde(default)]
    pub indexes: Vec<IndexDefinition>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct UniqueConstraint {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub primary_key: bool,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForeignKeyConstraint {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub foreign_table: String,
    pub referred_columns: Vec<String>,
    #[serde(default)]
    pub on_delete: ForeignKeyAction,
    #[serde(default)]
    pub on_update: ForeignKeyAction,
}

#[derive(Clone, Copy, Debug, Default, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum ForeignKeyAction {
    #[default]
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckConstraint {
    pub name: Option<String>,
    pub expression: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct ColumnDefault {
    pub column: String,
    pub value: SqlValue,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct ConstraintDescription {
    pub table_name: String,
    pub constraints: RelationalConstraints,
}

// ============================================================================
// The persistent (immutable) database value
// ============================================================================

/// One table's schema and data - a plain, immutable value. `rows` is keyed by
/// a row id assigned at insert time (monotonically increasing per table) -
/// an internal handle for `UPDATE`/`DELETE` to target, not a user-visible
/// primary key.
#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    pub columns: Vec<ColumnDef>,
    pub constraints: RelationalConstraints,
    pub rows: OrdMap<u64, Row>,
    pub next_row_id: u64,
}

/// The whole database: an immutable map of table name to [`Table`]. Every
/// function that "changes" a `Database` returns a new one - see this
/// module's doc comment.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Database {
    pub tables: OrdMap<String, Table>,
}

/// The already-authenticated subject and owner column used for one statement.
/// Authentication stays outside the pure engine; enforcement stays inside it.
#[derive(Clone, Copy, Debug)]
pub struct OwnerPolicy<'a> {
    pub owner_column: &'a str,
    pub subject: &'a str,
}

#[cfg(test)]
impl Database {
    pub fn new() -> Self {
        Self {
            tables: OrdMap::new(),
        }
    }
}

// ============================================================================
// Entry points
// ============================================================================

/// Parses and executes one SQL statement against `db`, returning the
/// resulting database (identical to `db` for a read-only statement) and the
/// statement's result. The single pure entry point the rest of the canister
/// goes through.
pub fn apply(db: &Database, sql: &str) -> Result<(Database, QueryResult), String> {
    let stmt = parse_one(sql)?;
    apply_statement(db, &stmt, None)
}

/// Executes one statement with owner-column RLS. This is deliberately a
/// separate entry point so callers cannot accidentally confuse authentication
/// with SQL text rewriting.
pub fn apply_with_owner_policy(
    db: &Database,
    sql: &str,
    policy: OwnerPolicy<'_>,
) -> Result<(Database, QueryResult), String> {
    let stmt = parse_one(sql)?;
    apply_statement(db, &stmt, Some(policy))
}

fn apply_statement(
    db: &Database,
    stmt: &Statement,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<(Database, QueryResult), String> {
    let outcome = match &stmt {
        Statement::CreateTable(_) if policy.is_some() => {
            Err("RLS policies do not authorize schema changes".to_string())
        }
        Statement::CreateTable(_) => apply_create_table(db, stmt),
        Statement::Insert(_) => apply_insert(db, stmt, policy),
        Statement::Query(_) => apply_select(db, stmt, policy).map(|result| (db.clone(), result)),
        Statement::Delete(_) => apply_delete(db, stmt, policy),
        Statement::Update(_) => apply_update(db, stmt, policy),
        Statement::Drop { .. } if policy.is_some() => {
            Err("RLS policies do not authorize schema changes".to_string())
        }
        Statement::Drop {
            object_type: ObjectType::Table,
            ..
        } => apply_drop_table(db, stmt),
        Statement::Drop {
            object_type: ObjectType::Index,
            ..
        } => apply_drop_index(db, stmt),
        Statement::Drop { object_type, .. } => Err(format!("DROP {object_type} is not supported")),
        Statement::AlterTable(_) if policy.is_some() => {
            Err("RLS policies do not authorize schema changes".to_string())
        }
        Statement::AlterTable(_) => apply_alter_table(db, stmt),
        Statement::CreateIndex(_) if policy.is_some() => {
            Err("RLS policies do not authorize schema changes".to_string())
        }
        Statement::CreateIndex(_) => apply_create_index(db, stmt),
        other => Err(format!("Unsupported statement: {other:?}")),
    }?;
    if !matches!(stmt, Statement::Query(_)) {
        validate_database(&outcome.0)?;
    }
    Ok(outcome)
}

/// Returns the single table targeted by the subset of SQL this engine
/// supports. Used by the canister shell to look up stable RLS metadata.
#[cfg(test)]
pub fn statement_table(sql: &str) -> Result<Option<String>, String> {
    Ok(statement_tables(sql)?.into_iter().next())
}

/// Returns every directly referenced table in statement order. Derived tables
/// are intentionally rejected by execution, so this list is also the RLS
/// policy-resolution boundary used by the canister shell.
pub fn statement_tables(sql: &str) -> Result<Vec<String>, String> {
    let stmt = parse_one(sql)?;
    match stmt {
        Statement::CreateTable(create) => Ok(vec![create.name.to_string().to_lowercase()]),
        Statement::Insert(insert) => Ok(vec![insert.table.to_string().to_lowercase()]),
        Statement::Query(query) => match query.body.as_ref() {
            SetExpr::Select(select) => {
                let mut names = Vec::new();
                for from in &select.from {
                    names.push(table_factor_name(&from.relation)?);
                    for join in &from.joins {
                        names.push(table_factor_name(&join.relation)?);
                    }
                }
                Ok(names)
            }
            _ => Ok(vec![]),
        },
        Statement::Delete(delete) => delete_table_name(&delete).map(|name| vec![name]),
        Statement::Update(update) => Ok(vec![update.table.relation.to_string().to_lowercase()]),
        Statement::Drop {
            object_type: ObjectType::Table,
            names,
            ..
        } if names.len() == 1 => Ok(vec![names[0].to_string().to_lowercase()]),
        Statement::Drop {
            object_type: ObjectType::Table,
            ..
        } => Err(
            "execute DROP for one table at a time so security policies can be resolved".to_string(),
        ),
        Statement::Drop {
            object_type: ObjectType::Index,
            ..
        } => Ok(vec![]),
        Statement::AlterTable(alter) => Ok(vec![alter.name.to_string().to_lowercase()]),
        Statement::CreateIndex(index) => Ok(vec![index.table_name.to_string().to_lowercase()]),
        _ => Ok(vec![]),
    }
}

fn table_factor_name(factor: &TableFactor) -> Result<String, String> {
    match factor {
        TableFactor::Table { name, .. } => Ok(name.to_string().to_lowercase()),
        _ => Err("only named tables are supported".to_string()),
    }
}

/// True if `sql` parses as a single read-only (`SELECT`) statement. Used by
/// the canister's `query` endpoint to reject a mutation up front: an IC query
/// call's state changes are never committed, so letting one through here
/// would silently discard the write instead of reporting it as an error.
pub fn is_read_only(sql: &str) -> Result<bool, String> {
    Ok(matches!(parse_one(sql)?, Statement::Query(_)))
}

pub(crate) fn equality_lookup(sql: &str) -> Result<Option<(String, String, SqlValue)>, String> {
    let Statement::Query(query) = parse_one(sql)? else {
        return Ok(None);
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Ok(None);
    };
    if select.from.len() != 1 || !select.from[0].joins.is_empty() {
        return Ok(None);
    }
    let Some(condition) = &select.selection else {
        return Ok(None);
    };
    fn find(expression: &Expr) -> Option<(&Expr, &Expr)> {
        match expression {
            Expr::BinaryOp { left, op, right } if op.to_string() == "=" => Some((left, right)),
            Expr::BinaryOp { left, op, right } if op.to_string() == "AND" => {
                find(left).or_else(|| find(right))
            }
            Expr::Nested(inner) => find(inner),
            _ => None,
        }
    }
    let Some((left, right)) = find(condition) else {
        return Ok(None);
    };
    let pair = if matches!(left, Expr::Identifier(_) | Expr::CompoundIdentifier(_)) {
        Some((left, right))
    } else if matches!(right, Expr::Identifier(_) | Expr::CompoundIdentifier(_)) {
        Some((right, left))
    } else {
        None
    };
    let Some((column, value)) = pair else {
        return Ok(None);
    };
    let value = match parse_sql_value(value) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(Some((
        table_factor_name(&select.from[0].relation)?,
        expression_column_name(column)?,
        value,
    )))
}

#[cfg(test)]
pub fn list_tables(db: &Database) -> Vec<String> {
    db.tables.keys().cloned().collect()
}

#[cfg(test)]
pub fn describe_table(db: &Database, table_name: &str) -> Result<TableDescription, String> {
    let name = table_name.to_lowercase();
    let table = db
        .tables
        .get(&name)
        .ok_or_else(|| format!("Table '{name}' not found"))?;
    Ok(TableDescription {
        name,
        columns: table.columns.clone(),
        row_count: table.rows.len() as u64,
    })
}

fn parse_one(sql: &str) -> Result<Statement, String> {
    // PostgreSQL dialect (not the previous `GenericDialect`) - see this
    // crate's rename to `ic-sql`: SQL text is now parsed with Postgres's
    // own syntax rules (e.g. `::` type casts, `ILIKE`, double-quoted
    // identifiers rather than string literals), even though the engine
    // below still only *executes* the same small statement subset described
    // in this module's doc comment - a caller can now write idiomatically
    // Postgres SQL and have it parse, without every clause it accepts also
    // being semantically supported yet.
    let dialect = PostgreSqlDialect {};
    let mut statements =
        Parser::parse_sql(&dialect, sql).map_err(|e| format!("Parse error: {e}"))?;
    if statements.is_empty() {
        return Err("No SQL statement provided".to_string());
    }
    if statements.len() != 1 {
        return Err(
            "Exactly one SQL statement is allowed; use execute_batch for transactions".to_string(),
        );
    }
    Ok(statements.remove(0))
}

// ============================================================================
// CREATE TABLE
// ============================================================================

fn apply_create_table(db: &Database, stmt: &Statement) -> Result<(Database, QueryResult), String> {
    let Statement::CreateTable(create) = stmt else {
        unreachable!("apply_create_table called with a non-CreateTable statement")
    };
    let table_name = create.name.to_string().to_lowercase();

    if db.tables.contains_key(&table_name) {
        return Err(format!("Table '{table_name}' already exists"));
    }

    let columns: Vec<ColumnDef> = create
        .columns
        .iter()
        .map(|col| {
            let data_type = col.data_type.to_string();
            supported_type(&data_type)?;
            Ok(ColumnDef {
                name: col.name.value.to_lowercase(),
                data_type,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    if columns.is_empty() {
        return Err("Table must have at least one column".to_string());
    }
    let mut names = std::collections::BTreeSet::new();
    for column in &columns {
        if !names.insert(column.name.clone()) {
            return Err(format!(
                "Column '{}' is defined more than once",
                column.name
            ));
        }
    }

    let mut constraints = RelationalConstraints::default();
    for column in &create.columns {
        let name = column.name.value.to_lowercase();
        for option in &column.options {
            match &option.option {
                ColumnOption::Null => {}
                ColumnOption::NotNull => add_not_null(&mut constraints, &name),
                ColumnOption::Default(expression) => {
                    let value = parse_sql_value(expression)?;
                    let definition = &columns[require_column(&columns, &name)?];
                    if value != SqlValue::Null
                        && !value_matches_type(supported_type(&definition.data_type)?, &value)
                    {
                        return Err(format!(
                            "Default for '{}' does not match {}",
                            name, definition.data_type
                        ));
                    }
                    constraints.defaults.push(ColumnDefault {
                        column: name.clone(),
                        value,
                    });
                }
                ColumnOption::PrimaryKey(primary) => {
                    add_not_null(&mut constraints, &name);
                    constraints.unique.push(UniqueConstraint {
                        name: primary.name.as_ref().map(|name| name.value.to_lowercase()),
                        columns: vec![name.clone()],
                        primary_key: true,
                    });
                }
                ColumnOption::Unique(unique) => constraints.unique.push(UniqueConstraint {
                    name: unique.name.as_ref().map(|name| name.value.to_lowercase()),
                    columns: vec![name.clone()],
                    primary_key: false,
                }),
                ColumnOption::ForeignKey(foreign) => constraints
                    .foreign_keys
                    .push(foreign_key_definition(vec![name.clone()], foreign)?),
                ColumnOption::Check(check) => constraints.checks.push(CheckConstraint {
                    name: check.name.as_ref().map(|name| name.value.to_lowercase()),
                    expression: check.expr.to_string(),
                }),
                other => {
                    return Err(format!(
                        "Unsupported column constraint on '{name}': {other}"
                    ))
                }
            }
        }
    }
    for constraint in &create.constraints {
        match constraint {
            AstTableConstraint::PrimaryKey(primary) => {
                let names = index_column_names(&primary.columns)?;
                for name in &names {
                    require_column(&columns, name)?;
                    add_not_null(&mut constraints, name);
                }
                constraints.unique.push(UniqueConstraint {
                    name: primary.name.as_ref().map(|name| name.value.to_lowercase()),
                    columns: names,
                    primary_key: true,
                });
            }
            AstTableConstraint::Unique(unique) => {
                let names = index_column_names(&unique.columns)?;
                for name in &names {
                    require_column(&columns, name)?;
                }
                constraints.unique.push(UniqueConstraint {
                    name: unique.name.as_ref().map(|name| name.value.to_lowercase()),
                    columns: names,
                    primary_key: false,
                });
            }
            AstTableConstraint::ForeignKey(foreign) => {
                let names = foreign
                    .columns
                    .iter()
                    .map(|column| column.value.to_lowercase())
                    .collect::<Vec<_>>();
                for name in &names {
                    require_column(&columns, name)?;
                }
                constraints
                    .foreign_keys
                    .push(foreign_key_definition(names, foreign)?);
            }
            AstTableConstraint::Check(check) => constraints.checks.push(CheckConstraint {
                name: check.name.as_ref().map(|name| name.value.to_lowercase()),
                expression: check.expr.to_string(),
            }),
            other => return Err(format!("Unsupported table constraint: {other}")),
        }
    }
    if constraints
        .unique
        .iter()
        .filter(|constraint| constraint.primary_key)
        .count()
        > 1
    {
        return Err("A table may have only one PRIMARY KEY".to_string());
    }

    let table = Table {
        columns,
        constraints,
        rows: OrdMap::new(),
        next_row_id: 1,
    };
    let mut tables = db.tables.clone();
    tables.insert(table_name.clone(), table);

    Ok((
        Database { tables },
        QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: 0,
            message: format!("Table '{table_name}' created successfully"),
        },
    ))
}

fn add_not_null(constraints: &mut RelationalConstraints, column: &str) {
    if !constraints.not_null.iter().any(|name| name == column) {
        constraints.not_null.push(column.to_string());
    }
}

fn require_column(columns: &[ColumnDef], name: &str) -> Result<usize, String> {
    columns
        .iter()
        .position(|column| column.name == name)
        .ok_or_else(|| format!("Column '{name}' not found"))
}

fn index_column_names(columns: &[sqlparser::ast::IndexColumn]) -> Result<Vec<String>, String> {
    columns
        .iter()
        .map(|column| match &column.column.expr {
            Expr::Identifier(identifier) => Ok(identifier.value.to_lowercase()),
            other => Err(format!(
                "Constraint columns must be identifiers, got {other}"
            )),
        })
        .collect()
}

fn foreign_key_definition(
    columns: Vec<String>,
    foreign: &sqlparser::ast::ForeignKeyConstraint,
) -> Result<ForeignKeyConstraint, String> {
    let referred_columns = foreign
        .referred_columns
        .iter()
        .map(|column| column.value.to_lowercase())
        .collect::<Vec<_>>();
    if !referred_columns.is_empty() && columns.len() != referred_columns.len() {
        return Err("Foreign key column count does not match referenced column count".to_string());
    }
    Ok(ForeignKeyConstraint {
        name: foreign.name.as_ref().map(|name| name.value.to_lowercase()),
        columns,
        foreign_table: foreign.foreign_table.to_string().to_lowercase(),
        referred_columns,
        on_delete: foreign_key_action(foreign.on_delete.as_ref())?,
        on_update: foreign_key_action(foreign.on_update.as_ref())?,
    })
}

fn foreign_key_action(action: Option<&ReferentialAction>) -> Result<ForeignKeyAction, String> {
    match action {
        None | Some(ReferentialAction::NoAction) => Ok(ForeignKeyAction::NoAction),
        Some(ReferentialAction::Restrict) => Ok(ForeignKeyAction::Restrict),
        Some(ReferentialAction::Cascade) => Ok(ForeignKeyAction::Cascade),
        Some(ReferentialAction::SetNull) => Ok(ForeignKeyAction::SetNull),
        Some(ReferentialAction::SetDefault) => Ok(ForeignKeyAction::SetDefault),
    }
}

// ============================================================================
// INSERT
// ============================================================================

fn apply_insert(
    db: &Database,
    stmt: &Statement,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<(Database, QueryResult), String> {
    let Statement::Insert(insert) = stmt else {
        unreachable!("apply_insert called with a non-Insert statement")
    };
    let table_name = insert.table.to_string().to_lowercase();
    let table = db
        .tables
        .get(&table_name)
        .ok_or_else(|| format!("Table '{table_name}' not found"))?;

    let insert_columns: Vec<String> = if insert.columns.is_empty() {
        table.columns.iter().map(|c| c.name.clone()).collect()
    } else {
        insert
            .columns
            .iter()
            .map(|c| c.value.to_lowercase())
            .collect()
    };

    let rows_to_insert = match insert.source.as_ref().map(|s| s.body.as_ref()) {
        Some(SetExpr::Values(Values { rows, .. })) => rows,
        Some(_) => return Err("Only VALUES clause is supported for INSERT".to_string()),
        None => return Err("INSERT requires VALUES".to_string()),
    };

    let owner_index = policy
        .map(|policy| owner_column_index(table, policy.owner_column))
        .transpose()?;
    let new_rows: Vec<Row> = rows_to_insert
        .iter()
        .map(|value_row| {
            if value_row.len() != insert_columns.len() {
                return Err(format!(
                    "Column count mismatch: expected {}, got {}",
                    insert_columns.len(),
                    value_row.len()
                ));
            }
            let mut values = table
                .columns
                .iter()
                .map(|column| {
                    table
                        .constraints
                        .defaults
                        .iter()
                        .find(|default| default.column == column.name)
                        .map_or(SqlValue::Null, |default| default.value.clone())
                })
                .collect::<Vec<_>>();
            for (i, col_name) in insert_columns.iter().enumerate() {
                let col_idx = table
                    .columns
                    .iter()
                    .position(|c| &c.name == col_name)
                    .ok_or_else(|| format!("Column '{col_name}' not found"))?;
                values[col_idx] = parse_sql_value(&value_row[i])?;
            }
            if let (Some(index), Some(policy)) = (owner_index, policy) {
                let expected = SqlValue::Text(policy.subject.to_string());
                if values[index] != SqlValue::Null && values[index] != expected {
                    return Err(
                        "RLS WITH CHECK violation: owner column does not match authenticated user"
                            .to_string(),
                    );
                }
                values[index] = expected;
            }
            Ok(Row { values })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let inserted_count = new_rows.len() as u64;
    let mut rows = table.rows.clone();
    let mut next_row_id = table.next_row_id;
    for row in new_rows {
        rows.insert(next_row_id, row);
        next_row_id += 1;
    }
    let new_table = Table {
        columns: table.columns.clone(),
        constraints: table.constraints.clone(),
        rows,
        next_row_id,
    };
    validate_table(&new_table)?;

    let mut tables = db.tables.clone();
    tables.insert(table_name, new_table);
    Ok((
        Database { tables },
        QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: inserted_count,
            message: format!("{inserted_count} row(s) inserted"),
        },
    ))
}

// ============================================================================
// SELECT
// ============================================================================

fn apply_select(
    db: &Database,
    stmt: &Statement,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<QueryResult, String> {
    let Statement::Query(query) = stmt else {
        unreachable!("apply_select called with a non-Query statement")
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err("Only simple SELECT queries are supported".to_string());
    };
    if query.with.is_some() || query.fetch.is_some() || !query.locks.is_empty() {
        return Err("WITH, FETCH, and row-locking clauses are not supported".to_string());
    }
    let has_group_by = match &select.group_by {
        GroupByExpr::All(_) => true,
        GroupByExpr::Expressions(expressions, modifiers) => {
            !expressions.is_empty() || !modifiers.is_empty()
        }
    };
    let has_aggregate = select.projection.iter().any(|item| {
        matches!(
            item,
            SelectItem::UnnamedExpr(Expr::Function(_))
                | SelectItem::ExprWithAlias {
                    expr: Expr::Function(_),
                    ..
                }
        )
    });
    if has_group_by || has_aggregate {
        return apply_aggregate_select(db, query, select, policy);
    }
    if select.distinct.is_some()
        || select.having.is_some()
        || select.top.is_some()
        || select.into.is_some()
        || !select.lateral_views.is_empty()
        || select.prewhere.is_some()
        || !select.named_window.is_empty()
        || select.qualify.is_some()
    {
        return Err("DISTINCT, grouping, windowing, and SELECT INTO are not supported".to_string());
    }
    if select.from.len() != 1 {
        return Err("SELECT requires exactly one FROM table".to_string());
    }
    if !select.from[0].joins.is_empty() {
        return apply_join_select(db, query, select, policy);
    }
    let table_name = select.from[0].relation.to_string().to_lowercase();
    let table = db
        .tables
        .get(&table_name)
        .ok_or_else(|| format!("Table '{table_name}' not found"))?;

    let projection = projection_columns(&select.projection, &table.columns)?;
    let result_columns = projection
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();

    let owner_index = policy
        .map(|policy| owner_column_index(table, policy.owner_column))
        .transpose()?;
    let mut source_rows = Vec::new();
    for row in table.rows.values() {
        if !row_allowed(row, owner_index, policy) {
            continue;
        }
        if let Some(condition) = &select.selection {
            if !evaluate_condition(row, &table.columns, condition)? {
                continue;
            }
        }
        source_rows.push(row);
    }

    let ordering = order_columns(query.order_by.as_ref(), &table.columns)?;
    source_rows.sort_by(|left, right| compare_rows(left, right, &ordering));
    let (offset, limit) = query_window(query.limit_clause.as_ref())?;
    let result_rows = source_rows
        .into_iter()
        .skip(offset)
        .take(limit.unwrap_or(usize::MAX))
        .map(|row| {
            projection
                .iter()
                .map(|(_, index)| row.values.get(*index).cloned().unwrap_or(SqlValue::Null))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    Ok(QueryResult {
        columns: result_columns,
        rows_affected: result_rows.len() as u64,
        message: format!("{} row(s) returned", result_rows.len()),
        rows: result_rows,
    })
}

const MAX_JOIN_ROWS: usize = 100_000;
const MAX_GROUPS: usize = 10_000;

fn apply_aggregate_select(
    db: &Database,
    query: &sqlparser::ast::Query,
    select: &sqlparser::ast::Select,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<QueryResult, String> {
    if select.from.len() != 1 || !select.from[0].joins.is_empty() {
        return Err("aggregate queries over JOINs are not supported yet".to_string());
    }
    if select.having.is_some() {
        return Err(
            "HAVING is not supported yet; filter aggregate results in the caller".to_string(),
        );
    }
    if select.distinct.is_some() || select.top.is_some() || select.into.is_some() {
        return Err(
            "DISTINCT, TOP, and SELECT INTO are not supported in aggregate queries".to_string(),
        );
    }
    let table_name = select.from[0].relation.to_string().to_lowercase();
    let table = db
        .tables
        .get(&table_name)
        .ok_or_else(|| format!("Table '{table_name}' not found"))?;
    let owner_index = policy
        .map(|item| owner_column_index(table, item.owner_column))
        .transpose()?;
    let source = table
        .rows
        .values()
        .filter(|row| row_allowed(row, owner_index, policy))
        .filter_map(|row| match &select.selection {
            Some(condition) => match evaluate_condition(row, &table.columns, condition) {
                Ok(true) => Some(Ok(row.clone())),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            },
            None => Some(Ok(row.clone())),
        })
        .collect::<Result<Vec<_>, String>>()?;
    let group_expressions = match &select.group_by {
        GroupByExpr::Expressions(expressions, modifiers) if modifiers.is_empty() => expressions,
        GroupByExpr::Expressions(_, _) | GroupByExpr::All(_) => {
            return Err("GROUP BY ALL/ROLLUP/CUBE/TOTALS are not supported".to_string())
        }
    };
    let group_indices = group_expressions
        .iter()
        .map(|expr| expression_column_index(&table.columns, expr))
        .collect::<Result<Vec<_>, _>>()?;
    let mut groups: Vec<(Vec<SqlValue>, Vec<Row>)> = Vec::new();
    for row in source {
        let key = group_indices
            .iter()
            .map(|index| row.values.get(*index).cloned().unwrap_or(SqlValue::Null))
            .collect::<Vec<_>>();
        if let Some((_, rows)) = groups.iter_mut().find(|(candidate, _)| candidate == &key) {
            rows.push(row);
        } else {
            groups.push((key, vec![row]));
        }
        if groups.len() > MAX_GROUPS {
            return Err(format!("GROUP BY exceeds the {MAX_GROUPS}-group limit"));
        }
    }
    if group_indices.is_empty() && groups.is_empty() {
        groups.push((vec![], vec![]));
    }
    let mut result_columns = Vec::new();
    let mut result_rows = Vec::new();
    for (_, rows) in groups {
        let mut output = Vec::new();
        for item in &select.projection {
            let (expression, alias) = match item {
                SelectItem::UnnamedExpr(expression) => (expression, None),
                SelectItem::ExprWithAlias { expr, alias } => {
                    (expr, Some(alias.value.to_lowercase()))
                }
                other => return Err(format!("Unsupported aggregate projection: {other}")),
            };
            let (name, value) = match expression {
                Expr::Identifier(_) | Expr::CompoundIdentifier(_) => {
                    let index = expression_column_index(&table.columns, expression)?;
                    if !group_indices.contains(&index) {
                        return Err(format!(
                            "column '{}' must appear in GROUP BY",
                            expression_column_name(expression)?
                        ));
                    }
                    (
                        expression_column_name(expression)?,
                        rows.first()
                            .and_then(|row| row.values.get(index))
                            .cloned()
                            .unwrap_or(SqlValue::Null),
                    )
                }
                Expr::Function(function) => (
                    function.name.to_string().to_lowercase(),
                    aggregate_value(function, &rows, &table.columns)?,
                ),
                _ => return Err(format!("Unsupported aggregate expression: {expression}")),
            };
            if result_rows.is_empty() {
                result_columns.push(alias.unwrap_or(name));
            }
            output.push(value);
        }
        result_rows.push(output);
    }
    if result_columns.is_empty() {
        for item in &select.projection {
            result_columns.push(match item {
                SelectItem::UnnamedExpr(
                    expression @ (Expr::Identifier(_) | Expr::CompoundIdentifier(_)),
                ) => expression_column_name(expression)?,
                SelectItem::UnnamedExpr(Expr::Function(function)) => {
                    function.name.to_string().to_lowercase()
                }
                SelectItem::ExprWithAlias { alias, .. } => alias.value.to_lowercase(),
                other => return Err(format!("Unsupported aggregate projection: {other}")),
            });
        }
    }
    let ordering = order_columns(
        query.order_by.as_ref(),
        &result_columns
            .iter()
            .map(|name| ColumnDef {
                name: name.clone(),
                data_type: String::new(),
            })
            .collect::<Vec<_>>(),
    )?;
    result_rows.sort_by(|left, right| {
        compare_rows(
            &Row {
                values: left.clone(),
            },
            &Row {
                values: right.clone(),
            },
            &ordering,
        )
    });
    let (offset, limit) = query_window(query.limit_clause.as_ref())?;
    let result_rows = result_rows
        .into_iter()
        .skip(offset)
        .take(limit.unwrap_or(usize::MAX))
        .collect::<Vec<_>>();
    Ok(QueryResult {
        columns: result_columns,
        rows_affected: result_rows.len() as u64,
        message: format!("{} row(s) returned", result_rows.len()),
        rows: result_rows,
    })
}

fn aggregate_value(
    function: &sqlparser::ast::Function,
    rows: &[Row],
    columns: &[ColumnDef],
) -> Result<SqlValue, String> {
    if function.filter.is_some()
        || function.over.is_some()
        || !function.within_group.is_empty()
        || function.null_treatment.is_some()
        || !matches!(function.parameters, FunctionArguments::None)
    {
        return Err(
            "aggregate parameters, FILTER, OVER, and WITHIN GROUP are not supported".to_string(),
        );
    }
    let FunctionArguments::List(arguments) = &function.args else {
        return Err("aggregate requires parentheses".to_string());
    };
    if arguments.duplicate_treatment.is_some()
        || !arguments.clauses.is_empty()
        || arguments.args.len() != 1
    {
        return Err(
            "aggregate DISTINCT/ORDER/LIMIT and multiple arguments are not supported".to_string(),
        );
    }
    let argument = match &arguments.args[0] {
        FunctionArg::Unnamed(argument) => argument,
        _ => return Err("named aggregate arguments are not supported".to_string()),
    };
    let name = function.name.to_string().to_ascii_lowercase();
    if name == "count"
        && matches!(
            argument,
            FunctionArgExpr::Wildcard | FunctionArgExpr::QualifiedWildcard(_)
        )
    {
        return Ok(SqlValue::Integer(rows.len() as i64));
    }
    let FunctionArgExpr::Expr(expression) = argument else {
        return Err(format!("{name} requires a column argument"));
    };
    let index = expression_column_index(columns, expression)?;
    let values = rows
        .iter()
        .filter_map(|row| row.values.get(index))
        .filter(|value| **value != SqlValue::Null)
        .cloned()
        .collect::<Vec<_>>();
    match name.as_str() {
        "count" => Ok(SqlValue::Integer(values.len() as i64)),
        "sum" => {
            if values.is_empty() {
                return Ok(SqlValue::Null);
            }
            let mut integer = 0i64;
            let mut float = 0f64;
            let mut has_float = false;
            for value in values {
                match value {
                    SqlValue::Integer(value) => {
                        integer = integer.checked_add(value).ok_or("SUM overflow")?;
                        float += value as f64;
                    }
                    SqlValue::Float(value) => {
                        has_float = true;
                        float += value;
                    }
                    _ => return Err("SUM requires a numeric column".to_string()),
                }
            }
            if has_float {
                Ok(SqlValue::Float(float))
            } else {
                Ok(SqlValue::Integer(integer))
            }
        }
        "avg" => {
            if values.is_empty() {
                return Ok(SqlValue::Null);
            }
            let mut total = 0f64;
            for value in &values {
                total += match value {
                    SqlValue::Integer(value) => *value as f64,
                    SqlValue::Float(value) => *value,
                    _ => return Err("AVG requires a numeric column".to_string()),
                };
            }
            Ok(SqlValue::Float(total / values.len() as f64))
        }
        "min" | "max" => {
            let mut values = values.into_iter();
            let Some(mut best) = values.next() else {
                return Ok(SqlValue::Null);
            };
            for value in values {
                let order = compare_for_sort(&value, &best);
                if (name == "min" && order == Ordering::Less)
                    || (name == "max" && order == Ordering::Greater)
                {
                    best = value;
                }
            }
            Ok(best)
        }
        _ => Err(format!("Unsupported aggregate function '{name}'")),
    }
}

fn table_source(
    db: &Database,
    factor: &TableFactor,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<(Vec<ColumnDef>, Vec<Row>), String> {
    let TableFactor::Table {
        name,
        alias,
        args,
        with_hints,
        version,
        with_ordinality,
        partitions,
        json_path,
        sample,
        index_hints,
    } = factor
    else {
        return Err("only named tables are supported in JOINs".to_string());
    };
    if args.is_some()
        || !with_hints.is_empty()
        || version.is_some()
        || *with_ordinality
        || !partitions.is_empty()
        || json_path.is_some()
        || sample.is_some()
        || !index_hints.is_empty()
    {
        return Err(
            "table functions, hints, versions, partitions, and samples are not supported"
                .to_string(),
        );
    }
    if alias
        .as_ref()
        .is_some_and(|alias| !alias.columns.is_empty())
    {
        return Err("column aliases on joined tables are not supported".to_string());
    }
    let table_name = name.to_string().to_lowercase();
    let qualifier = alias.as_ref().map_or_else(
        || table_name.clone(),
        |alias| alias.name.value.to_lowercase(),
    );
    let table = db
        .tables
        .get(&table_name)
        .ok_or_else(|| format!("Table '{table_name}' not found"))?;
    let owner_index = policy
        .map(|item| owner_column_index(table, item.owner_column))
        .transpose()?;
    let columns = table
        .columns
        .iter()
        .map(|column| ColumnDef {
            name: format!("{qualifier}.{}", column.name),
            data_type: column.data_type.clone(),
        })
        .collect();
    let rows = table
        .rows
        .values()
        .filter(|row| row_allowed(row, owner_index, policy))
        .cloned()
        .collect();
    Ok((columns, rows))
}

fn join_constraint_matches(
    row: &Row,
    columns: &[ColumnDef],
    constraint: &JoinConstraint,
    left_width: usize,
) -> Result<bool, String> {
    match constraint {
        JoinConstraint::On(expression) => evaluate_condition(row, columns, expression),
        JoinConstraint::Using(names) => names.iter().try_fold(true, |matches, name| {
            if !matches {
                return Ok(false);
            }
            let name = name.to_string().to_lowercase();
            let left = columns[..left_width]
                .iter()
                .enumerate()
                .filter(|(_, column)| column.name.rsplit('.').next() == Some(name.as_str()))
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let right = columns[left_width..]
                .iter()
                .enumerate()
                .filter(|(_, column)| column.name.rsplit('.').next() == Some(name.as_str()))
                .map(|(index, _)| index + left_width)
                .collect::<Vec<_>>();
            if left.len() != 1 || right.len() != 1 {
                return Err(format!(
                    "USING column '{name}' must exist once on each side"
                ));
            }
            compare_values(&row.values[left[0]], &row.values[right[0]], "=")
        }),
        JoinConstraint::None => Ok(true),
        JoinConstraint::Natural => {
            Err("NATURAL JOIN is not supported; use ON or USING".to_string())
        }
    }
}

fn apply_join_select(
    db: &Database,
    query: &sqlparser::ast::Query,
    select: &sqlparser::ast::Select,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<QueryResult, String> {
    let from = &select.from[0];
    let (mut columns, mut rows) = table_source(db, &from.relation, policy)?;
    for join in &from.joins {
        if join.global {
            return Err("GLOBAL JOIN is not supported".to_string());
        }
        let (right_columns, right_rows) = table_source(db, &join.relation, None)?;
        let left_width = columns.len();
        let right_width = right_columns.len();
        let (constraint, left_outer, cross) = match &join.join_operator {
            JoinOperator::Join(constraint) | JoinOperator::Inner(constraint) => {
                (constraint, false, false)
            }
            JoinOperator::Left(constraint) | JoinOperator::LeftOuter(constraint) => {
                (constraint, true, false)
            }
            JoinOperator::CrossJoin(constraint) => (constraint, false, true),
            other => return Err(format!("Unsupported JOIN operator: {other:?}")),
        };
        if rows.len().saturating_mul(right_rows.len().max(1)) > MAX_JOIN_ROWS {
            return Err(format!(
                "JOIN exceeds the {MAX_JOIN_ROWS}-row intermediate limit"
            ));
        }
        columns.extend(right_columns);
        let mut joined = Vec::new();
        for left in rows {
            let mut matched = false;
            for right in &right_rows {
                let mut values = left.values.clone();
                values.extend(right.values.clone());
                let row = Row { values };
                if cross || join_constraint_matches(&row, &columns, constraint, left_width)? {
                    joined.push(row);
                    matched = true;
                }
            }
            if left_outer && !matched {
                let mut values = left.values;
                values.extend(vec![SqlValue::Null; right_width]);
                joined.push(Row { values });
            }
        }
        rows = joined;
    }
    if let Some(condition) = &select.selection {
        rows = rows
            .into_iter()
            .filter_map(|row| match evaluate_condition(&row, &columns, condition) {
                Ok(true) => Some(Ok(row)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, String>>()?;
    }
    let projection = projection_columns(&select.projection, &columns)?;
    let result_columns = projection
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let ordering = order_columns(query.order_by.as_ref(), &columns)?;
    rows.sort_by(|left, right| compare_rows(left, right, &ordering));
    let (offset, limit) = query_window(query.limit_clause.as_ref())?;
    let result_rows = rows
        .into_iter()
        .skip(offset)
        .take(limit.unwrap_or(usize::MAX))
        .map(|row| {
            projection
                .iter()
                .map(|(_, index)| row.values[*index].clone())
                .collect()
        })
        .collect::<Vec<_>>();
    Ok(QueryResult {
        columns: result_columns,
        rows_affected: result_rows.len() as u64,
        message: format!("{} row(s) returned", result_rows.len()),
        rows: result_rows,
    })
}

fn projection_columns(
    projection: &[SelectItem],
    columns: &[ColumnDef],
) -> Result<Vec<(String, usize)>, String> {
    let mut result = Vec::new();
    for item in projection {
        match item {
            SelectItem::Wildcard(_) => {
                result.extend(columns.iter().enumerate().map(|(index, column)| {
                    (
                        column
                            .name
                            .rsplit('.')
                            .next()
                            .unwrap_or(&column.name)
                            .to_string(),
                        index,
                    )
                }))
            }
            SelectItem::UnnamedExpr(expr @ (Expr::Identifier(_) | Expr::CompoundIdentifier(_))) => {
                let source = expression_column_name(expr)?;
                result.push((source, expression_column_index(columns, expr)?));
            }
            SelectItem::ExprWithAlias {
                expr: expr @ (Expr::Identifier(_) | Expr::CompoundIdentifier(_)),
                alias,
            } => {
                result.push((
                    alias.value.to_lowercase(),
                    expression_column_index(columns, expr)?,
                ));
            }
            SelectItem::QualifiedWildcard(prefix, _) => {
                let prefix = format!("{}.", prefix.to_string().to_lowercase());
                let matches = columns
                    .iter()
                    .enumerate()
                    .filter(|(_, column)| column.name.starts_with(&prefix))
                    .map(|(index, column)| {
                        (
                            column
                                .name
                                .rsplit('.')
                                .next()
                                .unwrap_or(&column.name)
                                .to_string(),
                            index,
                        )
                    })
                    .collect::<Vec<_>>();
                if matches.is_empty() {
                    return Err(format!(
                        "Unknown wildcard qualifier '{}.*'",
                        prefix.trim_end_matches('.')
                    ));
                }
                result.extend(matches);
            }
            other => return Err(format!("Unsupported SELECT projection: {other}")),
        }
    }
    Ok(result)
}

fn expression_column_name(expr: &Expr) -> Result<String, String> {
    match expr {
        Expr::Identifier(identifier) => Ok(identifier.value.to_lowercase()),
        Expr::CompoundIdentifier(parts) => Ok(parts
            .last()
            .ok_or("empty column reference")?
            .value
            .to_lowercase()),
        _ => Err(format!("Expected a column, got {expr}")),
    }
}

fn expression_column_index(columns: &[ColumnDef], expr: &Expr) -> Result<usize, String> {
    match expr {
        Expr::Identifier(identifier) => {
            let name = identifier.value.to_lowercase();
            let matches = columns
                .iter()
                .enumerate()
                .filter(|(_, column)| {
                    column.name == name || column.name.rsplit('.').next() == Some(name.as_str())
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [index] => Ok(*index),
                [] => Err(format!("Column '{name}' not found")),
                _ => Err(format!("Column reference '{name}' is ambiguous")),
            }
        }
        Expr::CompoundIdentifier(parts) if parts.len() >= 2 => {
            let qualified = format!(
                "{}.{}",
                parts[parts.len() - 2].value.to_lowercase(),
                parts[parts.len() - 1].value.to_lowercase()
            );
            columns
                .iter()
                .position(|column| column.name == qualified)
                .ok_or_else(|| format!("Column '{qualified}' not found"))
        }
        _ => Err(format!("Expected a column reference, got {expr}")),
    }
}

#[derive(Clone, Copy)]
struct RowOrdering {
    index: usize,
    ascending: bool,
    nulls_first: bool,
}

fn order_columns(
    order_by: Option<&sqlparser::ast::OrderBy>,
    columns: &[ColumnDef],
) -> Result<Vec<RowOrdering>, String> {
    let Some(order_by) = order_by else {
        return Ok(Vec::new());
    };
    let OrderByKind::Expressions(expressions) = &order_by.kind else {
        return Err("ORDER BY ALL is not supported".to_string());
    };
    expressions
        .iter()
        .map(|item| {
            if !matches!(
                &item.expr,
                Expr::Identifier(_) | Expr::CompoundIdentifier(_)
            ) {
                return Err(format!(
                    "ORDER BY requires a column name, got {}",
                    item.expr
                ));
            }
            let ascending = item.options.asc.unwrap_or(true);
            Ok(RowOrdering {
                index: expression_column_index(columns, &item.expr)?,
                ascending,
                nulls_first: item.options.nulls_first.unwrap_or(!ascending),
            })
        })
        .collect()
}

fn compare_rows(left: &Row, right: &Row, ordering: &[RowOrdering]) -> Ordering {
    for order in ordering {
        let left = left.values.get(order.index).unwrap_or(&SqlValue::Null);
        let right = right.values.get(order.index).unwrap_or(&SqlValue::Null);
        let (comparison, directional) = match (left, right) {
            (SqlValue::Null, SqlValue::Null) => (Ordering::Equal, false),
            (SqlValue::Null, _) => (
                if order.nulls_first {
                    Ordering::Less
                } else {
                    Ordering::Greater
                },
                false,
            ),
            (_, SqlValue::Null) => (
                if order.nulls_first {
                    Ordering::Greater
                } else {
                    Ordering::Less
                },
                false,
            ),
            _ => (compare_for_sort(left, right), true),
        };
        if comparison != Ordering::Equal {
            return if directional && !order.ascending {
                comparison.reverse()
            } else {
                comparison
            };
        }
    }
    Ordering::Equal
}

fn compare_for_sort(left: &SqlValue, right: &SqlValue) -> Ordering {
    match (left, right) {
        (SqlValue::Integer(left), SqlValue::Integer(right)) => left.cmp(right),
        (SqlValue::Float(left), SqlValue::Float(right)) => {
            left.partial_cmp(right).unwrap_or(Ordering::Equal)
        }
        (SqlValue::Integer(left), SqlValue::Float(right)) => {
            (*left as f64).partial_cmp(right).unwrap_or(Ordering::Equal)
        }
        (SqlValue::Float(left), SqlValue::Integer(right)) => left
            .partial_cmp(&(*right as f64))
            .unwrap_or(Ordering::Equal),
        (SqlValue::Text(left), SqlValue::Text(right)) => left.cmp(right),
        (SqlValue::Boolean(left), SqlValue::Boolean(right)) => left.cmp(right),
        _ => format!("{left:?}").cmp(&format!("{right:?}")),
    }
}

fn query_window(limit_clause: Option<&LimitClause>) -> Result<(usize, Option<usize>), String> {
    match limit_clause {
        None => Ok((0, None)),
        Some(LimitClause::LimitOffset {
            limit,
            offset,
            limit_by,
        }) => {
            if !limit_by.is_empty() {
                return Err("LIMIT BY is not supported".to_string());
            }
            let limit = limit.as_ref().map(nonnegative_usize).transpose()?;
            let offset = offset
                .as_ref()
                .map(|offset| nonnegative_usize(&offset.value))
                .transpose()?
                .unwrap_or(0);
            Ok((offset, limit))
        }
        Some(LimitClause::OffsetCommaLimit { offset, limit }) => {
            Ok((nonnegative_usize(offset)?, Some(nonnegative_usize(limit)?)))
        }
    }
}

fn nonnegative_usize(expr: &Expr) -> Result<usize, String> {
    match parse_sql_value(expr)? {
        SqlValue::Integer(value) if value >= 0 => {
            usize::try_from(value).map_err(|_| "LIMIT/OFFSET is too large".to_string())
        }
        _ => Err("LIMIT/OFFSET must be a non-negative integer".to_string()),
    }
}

// ============================================================================
// DELETE
// ============================================================================

fn apply_delete(
    db: &Database,
    stmt: &Statement,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<(Database, QueryResult), String> {
    let Statement::Delete(delete) = stmt else {
        unreachable!("apply_delete called with a non-Delete statement")
    };
    let table_name = delete_table_name(delete)?;
    let table = db
        .tables
        .get(&table_name)
        .ok_or_else(|| format!("Table '{table_name}' not found"))?;

    let owner_index = policy
        .map(|policy| owner_column_index(table, policy.owner_column))
        .transpose()?;
    let ids_to_delete: Vec<u64> = table
        .rows
        .iter()
        .filter(|(_, row)| row_allowed(row, owner_index, policy))
        .filter(|(_, row)| match &delete.selection {
            Some(condition) => evaluate_condition(row, &table.columns, condition).unwrap_or(false),
            None => true,
        })
        .map(|(id, _)| *id)
        .collect();

    let mut rows = table.rows.clone();
    for id in &ids_to_delete {
        rows.remove(id);
    }
    let deleted_count = ids_to_delete.len() as u64;
    let new_table = Table {
        columns: table.columns.clone(),
        constraints: table.constraints.clone(),
        rows,
        next_row_id: table.next_row_id,
    };
    validate_table(&new_table)?;

    let mut tables = db.tables.clone();
    tables.insert(table_name, new_table);
    let mut next = Database { tables };
    apply_delete_referential_actions(db, &mut next)?;

    Ok((
        next,
        QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: deleted_count,
            message: format!("{deleted_count} row(s) deleted"),
        },
    ))
}

fn delete_table_name(delete: &Delete) -> Result<String, String> {
    let tables = match &delete.from {
        FromTable::WithFromKeyword(tables) => tables,
        FromTable::WithoutKeyword(tables) => tables,
    };
    Ok(tables
        .first()
        .ok_or("DELETE requires a table")?
        .relation
        .to_string()
        .to_lowercase())
}

// ============================================================================
// UPDATE
// ============================================================================

fn apply_update(
    db: &Database,
    stmt: &Statement,
    policy: Option<OwnerPolicy<'_>>,
) -> Result<(Database, QueryResult), String> {
    let Statement::Update(update) = stmt else {
        unreachable!("apply_update called with a non-Update statement")
    };
    let table_name = update.table.relation.to_string().to_lowercase();
    let table = db
        .tables
        .get(&table_name)
        .ok_or_else(|| format!("Table '{table_name}' not found"))?;

    let owner_index = policy
        .map(|policy| owner_column_index(table, policy.owner_column))
        .transpose()?;
    let assignments: Vec<(usize, SqlValue)> = update
        .assignments
        .iter()
        .map(|assignment| {
            let col_name = assignment.target.to_string().to_lowercase();
            let col_idx = table
                .columns
                .iter()
                .position(|c| c.name == col_name)
                .ok_or_else(|| format!("Column '{col_name}' not found"))?;
            Ok((col_idx, parse_sql_value(&assignment.value)?))
        })
        .collect::<Result<Vec<_>, String>>()?;

    if let (Some(index), Some(policy)) = (owner_index, policy) {
        if assignments.iter().any(|(column, value)| {
            *column == index && value != &SqlValue::Text(policy.subject.to_string())
        }) {
            return Err("RLS WITH CHECK violation: owner column cannot be reassigned".to_string());
        }
    }

    let updated_rows: Vec<(u64, Row)> = table
        .rows
        .iter()
        .filter(|(_, row)| row_allowed(row, owner_index, policy))
        .filter(|(_, row)| match &update.selection {
            Some(condition) => evaluate_condition(row, &table.columns, condition).unwrap_or(false),
            None => true,
        })
        .map(|(id, row)| {
            let mut new_row = row.clone();
            for (col_idx, value) in &assignments {
                if *col_idx < new_row.values.len() {
                    new_row.values[*col_idx] = value.clone();
                }
            }
            (*id, new_row)
        })
        .collect();

    let updated_count = updated_rows.len() as u64;
    let mut rows = table.rows.clone();
    for (id, new_row) in updated_rows {
        rows.insert(id, new_row);
    }
    let new_table = Table {
        columns: table.columns.clone(),
        constraints: table.constraints.clone(),
        rows,
        next_row_id: table.next_row_id,
    };
    validate_table(&new_table)?;

    let mut tables = db.tables.clone();
    tables.insert(table_name, new_table);
    let mut next = Database { tables };
    apply_update_referential_actions(db, &mut next)?;

    Ok((
        next,
        QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: updated_count,
            message: format!("{updated_count} row(s) updated"),
        },
    ))
}

fn owner_column_index(table: &Table, owner_column: &str) -> Result<usize, String> {
    table
        .columns
        .iter()
        .position(|column| column.name == owner_column)
        .ok_or_else(|| format!("RLS owner column '{owner_column}' is missing"))
}

fn row_allowed(row: &Row, owner_index: Option<usize>, policy: Option<OwnerPolicy<'_>>) -> bool {
    match (owner_index, policy) {
        (Some(index), Some(policy)) => {
            row.values.get(index) == Some(&SqlValue::Text(policy.subject.to_string()))
        }
        _ => true,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ValueKind {
    Integer,
    Number,
    Text,
    Boolean,
    LegacyUntyped,
}

fn supported_type(data_type: &str) -> Result<ValueKind, String> {
    let kind = data_type.trim().to_ascii_uppercase();
    if [
        "SMALLINT",
        "INT",
        "INTEGER",
        "BIGINT",
        "SERIAL",
        "BIGSERIAL",
    ]
    .iter()
    .any(|name| kind == *name)
    {
        Ok(ValueKind::Integer)
    } else if ["REAL", "FLOAT", "DOUBLE", "NUMERIC", "DECIMAL"]
        .iter()
        .any(|name| kind.starts_with(name))
    {
        Ok(ValueKind::Number)
    } else if [
        "TEXT",
        "CHAR",
        "VARCHAR",
        "CHARACTER",
        "STRING",
        "UUID",
        "DATE",
        "TIME",
        "TIMESTAMP",
        "JSON",
        "JSONB",
    ]
    .iter()
    .any(|name| kind.starts_with(name))
    {
        Ok(ValueKind::Text)
    } else if kind == "BOOL" || kind == "BOOLEAN" {
        Ok(ValueKind::Boolean)
    } else {
        Err(format!("Unsupported column type '{data_type}'"))
    }
}

fn value_matches_type(kind: ValueKind, value: &SqlValue) -> bool {
    matches!(
        (kind, value),
        (ValueKind::Integer, SqlValue::Integer(_))
            | (ValueKind::Number, SqlValue::Integer(_) | SqlValue::Float(_))
            | (ValueKind::Text, SqlValue::Text(_))
            | (ValueKind::Boolean, SqlValue::Boolean(_))
            | (ValueKind::LegacyUntyped, _)
    )
}

fn validate_table(table: &Table) -> Result<(), String> {
    for row in table.rows.values() {
        for (index, column) in table.columns.iter().enumerate() {
            let value = row.values.get(index).unwrap_or(&SqlValue::Null);
            if value == &SqlValue::Null {
                if table
                    .constraints
                    .not_null
                    .iter()
                    .any(|name| name == &column.name)
                {
                    return Err(format!(
                        "NOT NULL constraint failed for column '{}'",
                        column.name
                    ));
                }
                continue;
            }
            // Releases before relational constraints accepted arbitrary type
            // labels. Keep those legacy columns readable/writable while new
            // CREATE TABLE statements reject unknown types.
            let kind = supported_type(&column.data_type).unwrap_or(ValueKind::LegacyUntyped);
            let valid = value_matches_type(kind, value);
            if !valid {
                return Err(format!(
                    "Type mismatch for column '{}': expected {}, got {value:?}",
                    column.name, column.data_type
                ));
            }
        }
    }

    for constraint in &table.constraints.unique {
        let indices = constraint
            .columns
            .iter()
            .map(|name| require_column(&table.columns, name))
            .collect::<Result<Vec<_>, _>>()?;
        let rows = table.rows.values().collect::<Vec<_>>();
        for left in 0..rows.len() {
            let left_key = indices
                .iter()
                .map(|index| rows[left].values.get(*index).unwrap_or(&SqlValue::Null))
                .collect::<Vec<_>>();
            if !constraint.primary_key && left_key.contains(&&SqlValue::Null) {
                continue;
            }
            for right in left + 1..rows.len() {
                let equal = indices.iter().all(|index| {
                    rows[left].values.get(*index).unwrap_or(&SqlValue::Null)
                        == rows[right].values.get(*index).unwrap_or(&SqlValue::Null)
                });
                if equal {
                    let kind = if constraint.primary_key {
                        "PRIMARY KEY"
                    } else {
                        "UNIQUE"
                    };
                    return Err(format!(
                        "{kind} constraint failed for ({})",
                        constraint.columns.join(", ")
                    ));
                }
            }
        }
    }
    for constraint in &table.constraints.checks {
        let expression = parse_check_expression(&constraint.expression)?;
        // Resolve identifiers even for an empty table, so a malformed schema
        // cannot be persisted and fail only after its first insert.
        let empty = Row {
            values: vec![SqlValue::Null; table.columns.len()],
        };
        evaluate_check_condition(&empty, &table.columns, &expression)?;
        for row in table.rows.values() {
            if evaluate_check_condition(row, &table.columns, &expression)? == Some(false) {
                let label = constraint
                    .name
                    .as_deref()
                    .map_or_else(|| constraint.expression.as_str(), |name| name);
                return Err(format!("CHECK constraint failed: {label}"));
            }
        }
    }
    Ok(())
}

fn validate_database(database: &Database) -> Result<(), String> {
    for (table_name, table) in &database.tables {
        validate_table(table)?;
        for foreign_key in &table.constraints.foreign_keys {
            let foreign_table =
                database
                    .tables
                    .get(&foreign_key.foreign_table)
                    .ok_or_else(|| {
                        format!(
                            "Foreign key on '{table_name}' references missing table '{}'",
                            foreign_key.foreign_table
                        )
                    })?;
            let referred_columns = if foreign_key.referred_columns.is_empty() {
                foreign_table
                    .constraints
                    .unique
                    .iter()
                    .find(|constraint| constraint.primary_key)
                    .map(|constraint| constraint.columns.clone())
                    .ok_or_else(|| {
                        format!(
                            "Referenced table '{}' has no PRIMARY KEY",
                            foreign_key.foreign_table
                        )
                    })?
            } else {
                foreign_key.referred_columns.clone()
            };
            if referred_columns.len() != foreign_key.columns.len() {
                return Err(format!(
                    "Foreign key on '{table_name}' has a different column count from its reference"
                ));
            }
            if !foreign_table
                .constraints
                .unique
                .iter()
                .any(|constraint| constraint.columns == referred_columns)
            {
                return Err(format!(
                    "Foreign key target {}({}) must be PRIMARY KEY or UNIQUE",
                    foreign_key.foreign_table,
                    referred_columns.join(", ")
                ));
            }
            let local_indices = foreign_key
                .columns
                .iter()
                .map(|name| require_column(&table.columns, name))
                .collect::<Result<Vec<_>, _>>()?;
            let foreign_indices = referred_columns
                .iter()
                .map(|name| require_column(&foreign_table.columns, name))
                .collect::<Result<Vec<_>, _>>()?;
            for (local, foreign) in local_indices.iter().zip(&foreign_indices) {
                if supported_type(&table.columns[*local].data_type)?
                    != supported_type(&foreign_table.columns[*foreign].data_type)?
                {
                    return Err(format!(
                        "Foreign key type mismatch between {}.{} and {}.{}",
                        table_name,
                        table.columns[*local].name,
                        foreign_key.foreign_table,
                        foreign_table.columns[*foreign].name
                    ));
                }
            }
            for row in table.rows.values() {
                let key = local_indices
                    .iter()
                    .map(|index| row.values.get(*index).unwrap_or(&SqlValue::Null))
                    .collect::<Vec<_>>();
                if key.contains(&&SqlValue::Null) {
                    continue;
                }
                let found = foreign_table.rows.values().any(|candidate| {
                    key.iter().zip(&foreign_indices).all(|(value, index)| {
                        *value == candidate.values.get(*index).unwrap_or(&SqlValue::Null)
                    })
                });
                if !found {
                    return Err(format!(
                        "FOREIGN KEY constraint failed on {}({})",
                        table_name,
                        foreign_key.columns.join(", ")
                    ));
                }
            }
        }
    }
    Ok(())
}

const MAX_CASCADE_ROWS: usize = 10_000;

fn referred_columns(
    database: &Database,
    foreign: &ForeignKeyConstraint,
) -> Result<Vec<String>, String> {
    if !foreign.referred_columns.is_empty() {
        return Ok(foreign.referred_columns.clone());
    }
    database
        .tables
        .get(&foreign.foreign_table)
        .and_then(|table| table.constraints.unique.iter().find(|key| key.primary_key))
        .map(|key| key.columns.clone())
        .ok_or_else(|| {
            format!(
                "Referenced table '{}' has no PRIMARY KEY",
                foreign.foreign_table
            )
        })
}

fn row_key(row: &Row, columns: &[ColumnDef], names: &[String]) -> Result<Vec<SqlValue>, String> {
    names
        .iter()
        .map(|name| {
            let index = require_column(columns, name)?;
            Ok(row.values.get(index).cloned().unwrap_or(SqlValue::Null))
        })
        .collect()
}

fn apply_delete_referential_actions(old: &Database, next: &mut Database) -> Result<(), String> {
    let mut queue = Vec::<(String, Row)>::new();
    for (name, old_table) in &old.tables {
        if let Some(new_table) = next.tables.get(name) {
            for (id, row) in &old_table.rows {
                if !new_table.rows.contains_key(id) {
                    queue.push((name.clone(), row.clone()));
                }
            }
        }
    }
    let mut affected = 0usize;
    while let Some((parent_name, parent_row)) = queue.pop() {
        let parent_columns = old
            .tables
            .get(&parent_name)
            .or_else(|| next.tables.get(&parent_name))
            .ok_or_else(|| format!("Table '{parent_name}' not found during cascade"))?
            .columns
            .clone();
        let child_names = next.tables.keys().cloned().collect::<Vec<_>>();
        for child_name in child_names {
            let snapshot = next.tables.get(&child_name).expect("table exists").clone();
            for foreign in snapshot
                .constraints
                .foreign_keys
                .iter()
                .filter(|key| key.foreign_table == parent_name)
            {
                let referred = referred_columns(next, foreign)?;
                let key = row_key(&parent_row, &parent_columns, &referred)?;
                let local_indices = foreign
                    .columns
                    .iter()
                    .map(|name| require_column(&snapshot.columns, name))
                    .collect::<Result<Vec<_>, _>>()?;
                let matching = snapshot
                    .rows
                    .iter()
                    .filter(|(_, row)| {
                        local_indices.iter().enumerate().all(|(position, index)| {
                            row.values.get(*index).unwrap_or(&SqlValue::Null) == &key[position]
                        })
                    })
                    .map(|(id, row)| (*id, row.clone()))
                    .collect::<Vec<_>>();
                if matching.is_empty() {
                    continue;
                }
                match foreign.on_delete {
                    ForeignKeyAction::NoAction | ForeignKeyAction::Restrict => {
                        return Err(format!(
                            "FOREIGN KEY restricts deletion from '{parent_name}'"
                        ));
                    }
                    ForeignKeyAction::Cascade => {
                        let mut child = next.tables.get(&child_name).expect("table exists").clone();
                        for (id, row) in matching {
                            child.rows.remove(&id);
                            queue.push((child_name.clone(), row));
                            affected += 1;
                        }
                        next.tables.insert(child_name.clone(), child);
                    }
                    action @ (ForeignKeyAction::SetNull | ForeignKeyAction::SetDefault) => {
                        let mut child = next.tables.get(&child_name).expect("table exists").clone();
                        for (id, _) in matching {
                            let mut row = child.rows.get(&id).expect("row exists").clone();
                            for (column, index) in foreign.columns.iter().zip(&local_indices) {
                                row.values[*index] = match action {
                                    ForeignKeyAction::SetNull => SqlValue::Null,
                                    ForeignKeyAction::SetDefault => child
                                        .constraints
                                        .defaults
                                        .iter()
                                        .find(|item| &item.column == column)
                                        .map_or(SqlValue::Null, |item| item.value.clone()),
                                    _ => unreachable!(),
                                };
                            }
                            child.rows.insert(id, row);
                            affected += 1;
                        }
                        next.tables.insert(child_name.clone(), child);
                    }
                }
                if affected > MAX_CASCADE_ROWS {
                    return Err(format!(
                        "referential action exceeds {MAX_CASCADE_ROWS} rows"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn apply_update_referential_actions(old: &Database, next: &mut Database) -> Result<(), String> {
    let mut queue = Vec::<(String, Row, Row)>::new();
    for (name, old_table) in &old.tables {
        if let Some(new_table) = next.tables.get(name) {
            for (id, old_row) in &old_table.rows {
                if let Some(new_row) = new_table.rows.get(id).filter(|row| *row != old_row) {
                    queue.push((name.clone(), old_row.clone(), new_row.clone()));
                }
            }
        }
    }
    let mut affected = 0usize;
    while let Some((parent_name, old_parent, new_parent)) = queue.pop() {
        let parent = next
            .tables
            .get(&parent_name)
            .ok_or_else(|| format!("Table '{parent_name}' not found during cascade"))?
            .clone();
        let child_names = next.tables.keys().cloned().collect::<Vec<_>>();
        for child_name in child_names {
            let snapshot = next.tables.get(&child_name).expect("table exists").clone();
            for foreign in snapshot
                .constraints
                .foreign_keys
                .iter()
                .filter(|key| key.foreign_table == parent_name)
            {
                let referred = referred_columns(next, foreign)?;
                let old_key = row_key(&old_parent, &parent.columns, &referred)?;
                let new_key = row_key(&new_parent, &parent.columns, &referred)?;
                if old_key == new_key {
                    continue;
                }
                let local_indices = foreign
                    .columns
                    .iter()
                    .map(|name| require_column(&snapshot.columns, name))
                    .collect::<Result<Vec<_>, _>>()?;
                let matching = snapshot
                    .rows
                    .iter()
                    .filter(|(_, row)| {
                        local_indices.iter().enumerate().all(|(position, index)| {
                            row.values.get(*index).unwrap_or(&SqlValue::Null) == &old_key[position]
                        })
                    })
                    .map(|(id, _)| *id)
                    .collect::<Vec<_>>();
                if matching.is_empty() {
                    continue;
                }
                match foreign.on_update {
                    ForeignKeyAction::NoAction | ForeignKeyAction::Restrict => {
                        return Err(format!("FOREIGN KEY restricts update of '{parent_name}'"))
                    }
                    action => {
                        let mut child = next.tables.get(&child_name).expect("table exists").clone();
                        for id in matching {
                            let old_row = child.rows.get(&id).expect("row exists").clone();
                            let mut row = old_row.clone();
                            for (position, (column, index)) in
                                foreign.columns.iter().zip(&local_indices).enumerate()
                            {
                                row.values[*index] = match action {
                                    ForeignKeyAction::Cascade => new_key[position].clone(),
                                    ForeignKeyAction::SetNull => SqlValue::Null,
                                    ForeignKeyAction::SetDefault => child
                                        .constraints
                                        .defaults
                                        .iter()
                                        .find(|item| &item.column == column)
                                        .map_or(SqlValue::Null, |item| item.value.clone()),
                                    _ => unreachable!(),
                                };
                            }
                            if row != old_row {
                                child.rows.insert(id, row.clone());
                                queue.push((child_name.clone(), old_row, row));
                                affected += 1;
                            }
                        }
                        next.tables.insert(child_name.clone(), child);
                    }
                }
                if affected > MAX_CASCADE_ROWS {
                    return Err(format!(
                        "referential action exceeds {MAX_CASCADE_ROWS} rows"
                    ));
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// ALTER TABLE / CREATE INDEX
// ============================================================================

const MAX_SCHEMA_REWRITE_ROWS: usize = 10_000;

fn apply_alter_table(db: &Database, stmt: &Statement) -> Result<(Database, QueryResult), String> {
    let Statement::AlterTable(alter) = stmt else {
        unreachable!()
    };
    if alter.only
        || alter.location.is_some()
        || alter.on_cluster.is_some()
        || alter.table_type.is_some()
    {
        return Err(
            "ONLY, LOCATION, cluster, and special ALTER TABLE variants are not supported"
                .to_string(),
        );
    }
    let table_name = alter.name.to_string().to_lowercase();
    let Some(original) = db.tables.get(&table_name) else {
        if alter.if_exists {
            return Ok((db.clone(), empty_result("table did not exist")));
        }
        return Err(format!("Table '{table_name}' not found"));
    };
    if original.rows.len() > MAX_SCHEMA_REWRITE_ROWS {
        return Err(format!(
            "ALTER TABLE would rewrite more than {MAX_SCHEMA_REWRITE_ROWS} rows; migrate in bounded batches"
        ));
    }
    let mut next = db.clone();
    for operation in &alter.operations {
        apply_alter_operation(&mut next, &table_name, operation)?;
    }
    validate_database(&next)?;
    Ok((next, empty_result("table altered successfully")))
}

fn empty_result(message: &str) -> QueryResult {
    QueryResult {
        columns: vec![],
        rows: vec![],
        rows_affected: 0,
        message: message.to_string(),
    }
}

fn apply_alter_operation(
    database: &mut Database,
    table_name: &str,
    operation: &AlterTableOperation,
) -> Result<(), String> {
    match operation {
        AlterTableOperation::AddColumn {
            if_not_exists,
            column_def,
            column_position,
            ..
        } => {
            if column_position.is_some() {
                return Err("column positioning is not supported".to_string());
            }
            let name = column_def.name.value.to_lowercase();
            let table = database.tables.get(table_name).expect("table exists");
            if table.columns.iter().any(|column| column.name == name) {
                return if *if_not_exists {
                    Ok(())
                } else {
                    Err(format!("Column '{name}' already exists"))
                };
            }
            let data_type = column_def.data_type.to_string();
            supported_type(&data_type)?;
            let mut default = None;
            let mut not_null = false;
            for option in &column_def.options {
                match &option.option {
                    ColumnOption::Null => {}
                    ColumnOption::NotNull => not_null = true,
                    ColumnOption::Default(expr) => default = Some(parse_sql_value(expr)?),
                    other => return Err(format!("Unsupported ADD COLUMN constraint: {other}")),
                }
            }
            if not_null && default.is_none() && !table.rows.is_empty() {
                return Err(
                    "ADD COLUMN NOT NULL on a non-empty table requires a DEFAULT".to_string(),
                );
            }
            let fill = default.clone().unwrap_or(SqlValue::Null);
            if fill != SqlValue::Null && !value_matches_type(supported_type(&data_type)?, &fill) {
                return Err(format!("Default for '{name}' does not match {data_type}"));
            }
            let mut table = table.clone();
            table.columns.push(ColumnDef {
                name: name.clone(),
                data_type,
            });
            if not_null {
                add_not_null(&mut table.constraints, &name);
            }
            if let Some(value) = default {
                table.constraints.defaults.push(ColumnDefault {
                    column: name,
                    value,
                });
            }
            table.rows = table
                .rows
                .iter()
                .map(|(id, row)| {
                    let mut row = row.clone();
                    row.values.push(fill.clone());
                    (*id, row)
                })
                .collect();
            database.tables.insert(table_name.to_string(), table);
            Ok(())
        }
        AlterTableOperation::DropColumn {
            column_names,
            if_exists,
            drop_behavior,
            ..
        } => {
            if matches!(drop_behavior, Some(sqlparser::ast::DropBehavior::Cascade)) {
                return Err(
                    "DROP COLUMN CASCADE is not supported; remove dependent constraints explicitly"
                        .to_string(),
                );
            }
            for identifier in column_names {
                drop_column(
                    database,
                    table_name,
                    &identifier.value.to_lowercase(),
                    *if_exists,
                )?;
            }
            Ok(())
        }
        AlterTableOperation::RenameColumn {
            old_column_name,
            new_column_name,
        } => rename_column(
            database,
            table_name,
            &old_column_name.value.to_lowercase(),
            &new_column_name.value.to_lowercase(),
        ),
        AlterTableOperation::AlterColumn { column_name, op } => {
            let name = column_name.value.to_lowercase();
            let mut table = database
                .tables
                .get(table_name)
                .expect("table exists")
                .clone();
            let index = require_column(&table.columns, &name)?;
            match op {
                AlterColumnOperation::SetNotNull => add_not_null(&mut table.constraints, &name),
                AlterColumnOperation::DropNotNull => {
                    if table
                        .constraints
                        .unique
                        .iter()
                        .any(|key| key.primary_key && key.columns.contains(&name))
                    {
                        return Err("PRIMARY KEY columns cannot drop NOT NULL".to_string());
                    }
                    table.constraints.not_null.retain(|column| column != &name);
                }
                AlterColumnOperation::SetDefault { value } => {
                    let value = parse_sql_value(value)?;
                    if value != SqlValue::Null
                        && !value_matches_type(
                            supported_type(&table.columns[index].data_type)?,
                            &value,
                        )
                    {
                        return Err(format!("Default for '{name}' has the wrong type"));
                    }
                    table
                        .constraints
                        .defaults
                        .retain(|item| item.column != name);
                    table.constraints.defaults.push(ColumnDefault {
                        column: name,
                        value,
                    });
                }
                AlterColumnOperation::DropDefault => table
                    .constraints
                    .defaults
                    .retain(|item| item.column != name),
                _ => {
                    return Err(
                        "ALTER COLUMN TYPE and generated columns are not supported safely"
                            .to_string(),
                    )
                }
            }
            database.tables.insert(table_name.to_string(), table);
            Ok(())
        }
        AlterTableOperation::AddConstraint {
            constraint,
            not_valid,
        } => {
            if *not_valid {
                return Err("NOT VALID constraints are not supported".to_string());
            }
            let mut table = database
                .tables
                .get(table_name)
                .expect("table exists")
                .clone();
            add_table_constraint(&mut table, constraint)?;
            database.tables.insert(table_name.to_string(), table);
            Ok(())
        }
        AlterTableOperation::DropConstraint {
            if_exists,
            name,
            drop_behavior,
        } => {
            if matches!(drop_behavior, Some(sqlparser::ast::DropBehavior::Cascade)) {
                return Err("DROP CONSTRAINT CASCADE is not supported".to_string());
            }
            let name = name.value.to_lowercase();
            let mut table = database
                .tables
                .get(table_name)
                .expect("table exists")
                .clone();
            let before = table.constraints.unique.len()
                + table.constraints.foreign_keys.len()
                + table.constraints.checks.len()
                + table.constraints.indexes.len();
            table
                .constraints
                .unique
                .retain(|item| item.name.as_deref() != Some(&name));
            table
                .constraints
                .foreign_keys
                .retain(|item| item.name.as_deref() != Some(&name));
            table
                .constraints
                .checks
                .retain(|item| item.name.as_deref() != Some(&name));
            table.constraints.indexes.retain(|item| item.name != name);
            let after = table.constraints.unique.len()
                + table.constraints.foreign_keys.len()
                + table.constraints.checks.len()
                + table.constraints.indexes.len();
            if before == after && !*if_exists {
                return Err(format!("Constraint '{name}' not found"));
            }
            database.tables.insert(table_name.to_string(), table);
            Ok(())
        }
        AlterTableOperation::DropPrimaryKey { drop_behavior } => {
            if matches!(drop_behavior, Some(sqlparser::ast::DropBehavior::Cascade)) {
                return Err("DROP PRIMARY KEY CASCADE is not supported".to_string());
            }
            let mut table = database
                .tables
                .get(table_name)
                .expect("table exists")
                .clone();
            let Some(position) = table
                .constraints
                .unique
                .iter()
                .position(|key| key.primary_key)
            else {
                return Err("PRIMARY KEY not found".to_string());
            };
            // PostgreSQL keeps the column's NOT NULL property when the
            // primary-key constraint is dropped; doing the same also avoids
            // weakening an explicitly declared NOT NULL that shares it.
            table.constraints.unique.remove(position);
            database.tables.insert(table_name.to_string(), table);
            Ok(())
        }
        other => Err(format!("Unsupported ALTER TABLE operation: {other}")),
    }
}

fn add_table_constraint(table: &mut Table, constraint: &AstTableConstraint) -> Result<(), String> {
    match constraint {
        AstTableConstraint::Check(check) => table.constraints.checks.push(CheckConstraint {
            name: check.name.as_ref().map(|name| name.value.to_lowercase()),
            expression: check.expr.to_string(),
        }),
        AstTableConstraint::Unique(unique) => {
            let columns = index_column_names(&unique.columns)?;
            for column in &columns {
                require_column(&table.columns, column)?;
            }
            table.constraints.unique.push(UniqueConstraint {
                name: unique.name.as_ref().map(|name| name.value.to_lowercase()),
                columns,
                primary_key: false,
            });
        }
        AstTableConstraint::PrimaryKey(primary) => {
            if table.constraints.unique.iter().any(|key| key.primary_key) {
                return Err("A table may have only one PRIMARY KEY".to_string());
            }
            let columns = index_column_names(&primary.columns)?;
            for column in &columns {
                require_column(&table.columns, column)?;
                add_not_null(&mut table.constraints, column);
            }
            table.constraints.unique.push(UniqueConstraint {
                name: primary.name.as_ref().map(|name| name.value.to_lowercase()),
                columns,
                primary_key: true,
            });
        }
        AstTableConstraint::ForeignKey(foreign) => {
            let columns = foreign
                .columns
                .iter()
                .map(|column| column.value.to_lowercase())
                .collect::<Vec<_>>();
            for column in &columns {
                require_column(&table.columns, column)?;
            }
            table
                .constraints
                .foreign_keys
                .push(foreign_key_definition(columns, foreign)?);
        }
        other => return Err(format!("Unsupported constraint: {other}")),
    }
    Ok(())
}

fn drop_column(
    database: &mut Database,
    table_name: &str,
    column: &str,
    if_exists: bool,
) -> Result<(), String> {
    let table = database.tables.get(table_name).expect("table exists");
    let Some(index) = table.columns.iter().position(|item| item.name == column) else {
        return if if_exists {
            Ok(())
        } else {
            Err(format!("Column '{column}' not found"))
        };
    };
    let locally_used = table
        .constraints
        .unique
        .iter()
        .any(|key| key.columns.iter().any(|name| name == column))
        || table
            .constraints
            .foreign_keys
            .iter()
            .any(|key| key.columns.iter().any(|name| name == column))
        || table
            .constraints
            .indexes
            .iter()
            .any(|key| key.columns.iter().any(|name| name == column));
    let remotely_used = database.tables.iter().any(|(_, candidate)| {
        candidate.constraints.foreign_keys.iter().any(|key| {
            key.foreign_table == table_name
                && key.referred_columns.iter().any(|name| name == column)
        })
    });
    if locally_used || remotely_used || !table.constraints.checks.is_empty() {
        return Err(format!(
            "Column '{column}' has dependent constraints; drop them explicitly first"
        ));
    }
    let mut table = table.clone();
    table.columns.remove(index);
    table.constraints.not_null.retain(|name| name != column);
    table
        .constraints
        .defaults
        .retain(|item| item.column != column);
    table.rows = table
        .rows
        .iter()
        .map(|(id, row)| {
            let mut row = row.clone();
            row.values.remove(index);
            (*id, row)
        })
        .collect();
    database.tables.insert(table_name.to_string(), table);
    Ok(())
}

fn rename_column(
    database: &mut Database,
    table_name: &str,
    old: &str,
    new: &str,
) -> Result<(), String> {
    let table = database.tables.get(table_name).expect("table exists");
    let index = require_column(&table.columns, old)?;
    if table.columns.iter().any(|column| column.name == new) {
        return Err(format!("Column '{new}' already exists"));
    }
    if !table.constraints.checks.is_empty() {
        return Err(
            "rename a column only after removing CHECK constraints that may reference it"
                .to_string(),
        );
    }
    let mut table = table.clone();
    table.columns[index].name = new.to_string();
    rename_in_constraints(&mut table.constraints, old, new, false);
    database.tables.insert(table_name.to_string(), table);
    let names = database.tables.keys().cloned().collect::<Vec<_>>();
    for name in names {
        let mut candidate = database.tables.get(&name).expect("table exists").clone();
        for foreign in &mut candidate.constraints.foreign_keys {
            if foreign.foreign_table == table_name {
                for referred in &mut foreign.referred_columns {
                    if referred == old {
                        *referred = new.to_string();
                    }
                }
            }
        }
        database.tables.insert(name, candidate);
    }
    Ok(())
}

fn rename_in_constraints(
    constraints: &mut RelationalConstraints,
    old: &str,
    new: &str,
    referred: bool,
) {
    for name in &mut constraints.not_null {
        if name == old {
            *name = new.to_string();
        }
    }
    for item in &mut constraints.defaults {
        if item.column == old {
            item.column = new.to_string();
        }
    }
    for key in &mut constraints.unique {
        for name in &mut key.columns {
            if name == old {
                *name = new.to_string();
            }
        }
    }
    for key in &mut constraints.indexes {
        for name in &mut key.columns {
            if name == old {
                *name = new.to_string();
            }
        }
    }
    if !referred {
        for key in &mut constraints.foreign_keys {
            for name in &mut key.columns {
                if name == old {
                    *name = new.to_string();
                }
            }
        }
    }
}

fn apply_create_index(db: &Database, stmt: &Statement) -> Result<(Database, QueryResult), String> {
    let Statement::CreateIndex(index) = stmt else {
        unreachable!()
    };
    if index.concurrently
        || index.using.is_some()
        || !index.include.is_empty()
        || index.predicate.is_some()
        || !index.with.is_empty()
        || !index.index_options.is_empty()
        || !index.alter_options.is_empty()
    {
        return Err("only plain full-table B-tree indexes are supported".to_string());
    }
    let table_name = index.table_name.to_string().to_lowercase();
    let mut table = db
        .tables
        .get(&table_name)
        .ok_or_else(|| format!("Table '{table_name}' not found"))?
        .clone();
    if table.rows.len() > MAX_SCHEMA_REWRITE_ROWS {
        return Err(format!(
            "CREATE INDEX would scan more than {MAX_SCHEMA_REWRITE_ROWS} rows; migrate in bounded batches"
        ));
    }
    let columns = index_column_names(&index.columns)?;
    for column in &columns {
        require_column(&table.columns, column)?;
    }
    let name = index
        .name
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{}_{}_idx", table_name, columns.join("_")))
        .to_lowercase();
    if db.tables.iter().any(|(candidate_name, candidate)| {
        candidate_name != &table_name
            && candidate
                .constraints
                .indexes
                .iter()
                .any(|item| item.name == name)
    }) {
        return Err(format!("Index '{name}' already exists"));
    }
    if table
        .constraints
        .indexes
        .iter()
        .any(|item| item.name == name)
    {
        if index.if_not_exists {
            return Ok((db.clone(), empty_result("index already exists")));
        }
        return Err(format!("Index '{name}' already exists"));
    }
    if index.unique {
        table.constraints.unique.push(UniqueConstraint {
            name: Some(name.clone()),
            columns: columns.clone(),
            primary_key: false,
        });
    }
    table.constraints.indexes.push(IndexDefinition {
        name: name.clone(),
        columns,
        unique: index.unique,
    });
    let mut tables = db.tables.clone();
    tables.insert(table_name, table);
    let next = Database { tables };
    validate_database(&next)?;
    Ok((next, empty_result(&format!("index '{name}' created"))))
}

fn apply_drop_index(db: &Database, stmt: &Statement) -> Result<(Database, QueryResult), String> {
    let Statement::Drop {
        object_type: ObjectType::Index,
        if_exists,
        names,
        cascade,
        table,
        ..
    } = stmt
    else {
        unreachable!()
    };
    if *cascade || table.is_some() {
        return Err("DROP INDEX CASCADE and MySQL DROP INDEX ... ON are not supported".to_string());
    }
    let mut next = db.clone();
    for object_name in names {
        let name = object_name.to_string().to_lowercase();
        let owner = next.tables.iter().find_map(|(table_name, candidate)| {
            candidate
                .constraints
                .indexes
                .iter()
                .any(|index| index.name == name)
                .then(|| table_name.clone())
        });
        let Some(owner) = owner else {
            if *if_exists {
                continue;
            }
            return Err(format!("Index '{name}' not found"));
        };
        let mut owner_table = next.tables.get(&owner).expect("index owner exists").clone();
        owner_table
            .constraints
            .indexes
            .retain(|index| index.name != name);
        owner_table
            .constraints
            .unique
            .retain(|constraint| constraint.name.as_deref() != Some(&name));
        next.tables.insert(owner, owner_table);
    }
    validate_database(&next)?;
    Ok((
        next,
        empty_result(&format!("{} index(es) dropped", names.len())),
    ))
}

// ============================================================================
// DROP TABLE
// ============================================================================

fn apply_drop_table(db: &Database, stmt: &Statement) -> Result<(Database, QueryResult), String> {
    let Statement::Drop { names, .. } = stmt else {
        unreachable!("apply_drop_table called with a non-Drop statement")
    };

    let mut tables = db.tables.clone();
    for name in names {
        let table_name = name.to_string().to_lowercase();
        if tables.remove(&table_name).is_none() {
            // Returning here means `tables` (a local clone) is simply dropped -
            // `db` itself was never touched, so a DROP TABLE naming an
            // unknown table alongside real ones drops nothing at all, not
            // "everything named before the bad one".
            return Err(format!("Table '{table_name}' not found"));
        }
    }

    Ok((
        Database { tables },
        QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: names.len() as u64,
            message: format!("{} table(s) dropped", names.len()),
        },
    ))
}

// ============================================================================
// Expression evaluation (pure - operates on borrowed values only)
// ============================================================================

fn parse_sql_value(expr: &Expr) -> Result<SqlValue, String> {
    match expr {
        Expr::Value(value_with_span) => match &value_with_span.value {
            SqlParserValue::Number(n, _) => {
                if n.contains('.') {
                    n.parse::<f64>()
                        .map(SqlValue::Float)
                        .map_err(|e| e.to_string())
                } else {
                    n.parse::<i64>()
                        .map(SqlValue::Integer)
                        .map_err(|e| e.to_string())
                }
            }
            SqlParserValue::SingleQuotedString(s) | SqlParserValue::DoubleQuotedString(s) => {
                Ok(SqlValue::Text(s.clone()))
            }
            SqlParserValue::Boolean(b) => Ok(SqlValue::Boolean(*b)),
            SqlParserValue::Null => Ok(SqlValue::Null),
            other => Err(format!("Unsupported value type: {other:?}")),
        },
        Expr::UnaryOp { op, expr } => {
            if format!("{op}") == "-" {
                match parse_sql_value(expr)? {
                    SqlValue::Integer(i) => Ok(SqlValue::Integer(-i)),
                    SqlValue::Float(f) => Ok(SqlValue::Float(-f)),
                    other => Err(format!("Cannot negate {other:?}")),
                }
            } else {
                Err(format!("Unsupported unary operator: {op}"))
            }
        }
        other => Err(format!("Unsupported expression: {other:?}")),
    }
}

fn evaluate_condition(row: &Row, columns: &[ColumnDef], condition: &Expr) -> Result<bool, String> {
    Ok(evaluate_check_condition(row, columns, condition)? == Some(true))
}

/// SQL three-valued predicate evaluation. WHERE keeps only TRUE; CHECK
/// rejects only FALSE, so NULL/unknown values do not accidentally violate a
/// nullable CHECK constraint.
fn evaluate_check_condition(
    row: &Row,
    columns: &[ColumnDef],
    condition: &Expr,
) -> Result<Option<bool>, String> {
    match condition {
        Expr::BinaryOp { left, op, right } => match format!("{op}").as_str() {
            "AND" => match (
                evaluate_check_condition(row, columns, left)?,
                evaluate_check_condition(row, columns, right)?,
            ) {
                (Some(false), _) | (_, Some(false)) => Ok(Some(false)),
                (Some(true), Some(true)) => Ok(Some(true)),
                _ => Ok(None),
            },
            "OR" => match (
                evaluate_check_condition(row, columns, left)?,
                evaluate_check_condition(row, columns, right)?,
            ) {
                (Some(true), _) | (_, Some(true)) => Ok(Some(true)),
                (Some(false), Some(false)) => Ok(Some(false)),
                _ => Ok(None),
            },
            op_str => {
                let left_val = evaluate_expr(row, columns, left)?;
                let right_val = evaluate_expr(row, columns, right)?;
                if left_val == SqlValue::Null || right_val == SqlValue::Null {
                    Ok(None)
                } else {
                    compare_values(&left_val, &right_val, op_str).map(Some)
                }
            }
        },
        Expr::Nested(inner) => evaluate_check_condition(row, columns, inner),
        other => Err(format!("Unsupported condition: {other:?}")),
    }
}

fn parse_check_expression(expression: &str) -> Result<Expr, String> {
    let statement = parse_one(&format!("SELECT 1 WHERE {expression}"))?;
    let Statement::Query(query) = statement else {
        unreachable!()
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err("invalid CHECK expression".to_string());
    };
    select
        .selection
        .clone()
        .ok_or_else(|| "invalid CHECK expression".to_string())
}

fn evaluate_expr(row: &Row, columns: &[ColumnDef], expr: &Expr) -> Result<SqlValue, String> {
    match expr {
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) => expression_column_index(columns, expr)
            .map(|index| row.values.get(index).cloned().unwrap_or(SqlValue::Null)),
        Expr::Value(_) | Expr::UnaryOp { .. } => parse_sql_value(expr),
        other => Err(format!("Unsupported expression in condition: {other:?}")),
    }
}

fn compare_values(left: &SqlValue, right: &SqlValue, op: &str) -> Result<bool, String> {
    match (left, right) {
        (SqlValue::Integer(l), SqlValue::Integer(r)) => compare_ord(l, r, op),
        (SqlValue::Float(l), SqlValue::Float(r)) => match op {
            "=" => Ok((l - r).abs() < f64::EPSILON),
            "!=" | "<>" => Ok((l - r).abs() >= f64::EPSILON),
            "<" => Ok(l < r),
            ">" => Ok(l > r),
            "<=" => Ok(l <= r),
            ">=" => Ok(l >= r),
            _ => Err(format!("Unsupported operator: {op}")),
        },
        (SqlValue::Text(l), SqlValue::Text(r)) => compare_ord(l, r, op),
        (SqlValue::Boolean(l), SqlValue::Boolean(r)) => match op {
            "=" => Ok(l == r),
            "!=" | "<>" => Ok(l != r),
            _ => Err(format!("Unsupported operator for boolean: {op}")),
        },
        (SqlValue::Null, SqlValue::Null) => Ok(op == "="),
        (SqlValue::Null, _) | (_, SqlValue::Null) => Ok(false),
        (SqlValue::Integer(l), SqlValue::Float(r)) => {
            compare_values(&SqlValue::Float(*l as f64), &SqlValue::Float(*r), op)
        }
        (SqlValue::Float(l), SqlValue::Integer(r)) => {
            compare_values(&SqlValue::Float(*l), &SqlValue::Float(*r as f64), op)
        }
        _ => Err(format!("Cannot compare {left:?} with {right:?}")),
    }
}

fn compare_ord<T: PartialOrd + PartialEq>(l: &T, r: &T, op: &str) -> Result<bool, String> {
    match op {
        "=" => Ok(l == r),
        "!=" | "<>" => Ok(l != r),
        "<" => Ok(l < r),
        ">" => Ok(l > r),
        "<=" => Ok(l <= r),
        ">=" => Ok(l >= r),
        _ => Err(format!("Unsupported operator: {op}")),
    }
}

// ============================================================================
// Tests - pure logic, no ic_cdk/Wasm/canister runtime needed
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> String {
        format!("{name} {data_type}")
    }

    fn apply_ok(db: &Database, sql: &str) -> (Database, QueryResult) {
        apply(db, sql).unwrap_or_else(|e| panic!("expected {sql:?} to succeed, got: {e}"))
    }

    #[test]
    fn create_table_then_select_returns_an_empty_result() {
        let db = Database::new();
        let (db, created) = apply_ok(
            &db,
            &format!(
                "CREATE TABLE users ({}, {})",
                col("id", "INT"),
                col("name", "TEXT")
            ),
        );
        assert_eq!(created.message, "Table 'users' created successfully");

        let (_, selected) = apply_ok(&db, "SELECT * FROM users");
        assert_eq!(selected.columns, vec!["id".to_string(), "name".to_string()]);
        assert!(selected.rows.is_empty());
        assert_eq!(selected.rows_affected, 0);
    }

    #[test]
    fn create_table_rejects_a_duplicate_name() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT)");
        let err = apply(&db, "CREATE TABLE t (id INT)").unwrap_err();
        assert!(err.contains("already exists"), "unexpected error: {err}");
    }

    #[test]
    fn insert_then_select_round_trips_values() {
        let db = Database::new();
        let (db, _) = apply_ok(
            &db,
            "CREATE TABLE users (id INT, name TEXT, active BOOLEAN)",
        );
        let (db, inserted) = apply_ok(
            &db,
            "INSERT INTO users (id, name, active) VALUES (1, 'alice', true), (2, 'bob', false)",
        );
        assert_eq!(inserted.rows_affected, 2);

        let (_, selected) = apply_ok(&db, "SELECT * FROM users");
        assert_eq!(selected.rows_affected, 2);
        assert_eq!(
            selected.rows,
            vec![
                vec![
                    SqlValue::Integer(1),
                    SqlValue::Text("alice".to_string()),
                    SqlValue::Boolean(true)
                ],
                vec![
                    SqlValue::Integer(2),
                    SqlValue::Text("bob".to_string()),
                    SqlValue::Boolean(false)
                ],
            ]
        );
    }

    #[test]
    fn insert_without_a_column_list_uses_table_column_order() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (a INT, b INT)");
        let (db, _) = apply_ok(&db, "INSERT INTO t VALUES (1, 2)");
        let (_, selected) = apply_ok(&db, "SELECT * FROM t");
        assert_eq!(
            selected.rows,
            vec![vec![SqlValue::Integer(1), SqlValue::Integer(2)]]
        );
    }

    #[test]
    fn insert_rejects_a_column_count_mismatch() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (a INT, b INT)");
        let err = apply(&db, "INSERT INTO t VALUES (1)").unwrap_err();
        assert!(
            err.contains("Column count mismatch"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn select_with_where_filters_rows() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT, name TEXT)");
        let (db, _) = apply_ok(&db, "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
        let (_, selected) = apply_ok(&db, "SELECT name FROM t WHERE id > 1");
        assert_eq!(selected.columns, vec!["name".to_string()]);
        assert_eq!(
            selected.rows,
            vec![
                vec![SqlValue::Text("b".to_string())],
                vec![SqlValue::Text("c".to_string())]
            ]
        );
    }

    #[test]
    fn select_with_and_or_conditions() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT, active BOOLEAN)");
        let (db, _) = apply_ok(&db, "INSERT INTO t VALUES (1, true), (2, false), (3, true)");
        let (_, selected) = apply_ok(&db, "SELECT id FROM t WHERE active = true AND id > 1");
        assert_eq!(selected.rows, vec![vec![SqlValue::Integer(3)]]);
    }

    #[test]
    fn select_from_a_missing_table_is_an_error() {
        let db = Database::new();
        let err = apply(&db, "SELECT * FROM nope").unwrap_err();
        assert!(err.contains("not found"), "unexpected error: {err}");
    }

    #[test]
    fn update_changes_only_matching_rows() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT, status TEXT)");
        let (db, _) = apply_ok(&db, "INSERT INTO t VALUES (1, 'pending'), (2, 'pending')");
        let (db, updated) = apply_ok(&db, "UPDATE t SET status = 'done' WHERE id = 1");
        assert_eq!(updated.rows_affected, 1);

        let (_, selected) = apply_ok(&db, "SELECT id, status FROM t");
        assert_eq!(
            selected.rows,
            vec![
                vec![SqlValue::Integer(1), SqlValue::Text("done".to_string())],
                vec![SqlValue::Integer(2), SqlValue::Text("pending".to_string())],
            ]
        );
    }

    #[test]
    fn delete_without_where_removes_every_row() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT)");
        let (db, _) = apply_ok(&db, "INSERT INTO t VALUES (1), (2), (3)");
        let (db, deleted) = apply_ok(&db, "DELETE FROM t");
        assert_eq!(deleted.rows_affected, 3);
        let (_, selected) = apply_ok(&db, "SELECT * FROM t");
        assert!(selected.rows.is_empty());
    }

    #[test]
    fn delete_with_where_removes_only_matching_rows() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT)");
        let (db, _) = apply_ok(&db, "INSERT INTO t VALUES (1), (2), (3)");
        let (db, deleted) = apply_ok(&db, "DELETE FROM t WHERE id = 2");
        assert_eq!(deleted.rows_affected, 1);
        let (_, selected) = apply_ok(&db, "SELECT id FROM t");
        assert_eq!(
            selected.rows,
            vec![vec![SqlValue::Integer(1)], vec![SqlValue::Integer(3)]]
        );
    }

    #[test]
    fn drop_table_removes_it_from_list_tables() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT)");
        assert_eq!(list_tables(&db), vec!["t".to_string()]);
        let (db, dropped) = apply_ok(&db, "DROP TABLE t");
        assert_eq!(dropped.rows_affected, 1);
        assert!(list_tables(&db).is_empty());
    }

    #[test]
    fn drop_table_naming_an_unknown_table_changes_nothing_at_all() {
        // Exercises the atomicity note in this module's doc comment: `a`
        // exists, `nope` doesn't - the whole statement must fail and leave
        // `a` in place, not drop `a` and then report an error.
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE a (id INT)");
        let err = apply(&db, "DROP TABLE a, nope").unwrap_err();
        assert!(err.contains("not found"), "unexpected error: {err}");
        assert_eq!(
            list_tables(&db),
            vec!["a".to_string()],
            "table 'a' must survive a failed multi-table DROP"
        );
    }

    #[test]
    fn apply_never_mutates_the_database_it_was_given() {
        // The core claim of "functional": `db` is a `&Database` throughout -
        // this just double-checks a mutating call's *input* is unchanged by
        // comparing table lists before/after, rather than trusting the type
        // signature alone.
        let db = Database::new();
        let (before, _) = apply_ok(&db, "CREATE TABLE t (id INT)");
        let snapshot_before = list_tables(&before);
        let (_after, _) = apply_ok(&before, "INSERT INTO t VALUES (1)");
        assert_eq!(
            list_tables(&before),
            snapshot_before,
            "the `db` argument passed to apply must not change"
        );
    }

    #[test]
    fn query_mode_allows_select_and_rejects_everything_else() {
        assert!(is_read_only("SELECT * FROM t").unwrap());
        assert!(!is_read_only("INSERT INTO t VALUES (1)").unwrap());
        assert!(!is_read_only("DELETE FROM t").unwrap());
        assert!(!is_read_only("DROP TABLE t").unwrap());
        assert!(is_read_only("SELECT * FROM t; SELECT * FROM t").is_err());
    }

    #[test]
    fn policy_routing_rejects_multi_table_drop() {
        let error = statement_table("DROP TABLE a, b").unwrap_err();
        assert!(error.contains("one table at a time"));
    }

    #[test]
    fn describe_table_reports_columns_and_row_count() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE t (id INT, name TEXT)");
        let (db, _) = apply_ok(&db, "INSERT INTO t VALUES (1, 'a'), (2, 'b')");
        let description = describe_table(&db, "t").unwrap();
        assert_eq!(description.row_count, 2);
        assert_eq!(
            description.columns,
            vec![
                ColumnDef {
                    name: "id".to_string(),
                    data_type: "INT".to_string()
                },
                ColumnDef {
                    name: "name".to_string(),
                    data_type: "TEXT".to_string()
                }
            ]
        );
    }

    #[test]
    fn describe_table_is_case_insensitive_on_table_name() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE Users (id INT)");
        assert!(describe_table(&db, "USERS").is_ok());
    }

    #[test]
    fn owner_rls_is_consistent_for_insert_select_update_and_delete() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE docs (id INT, owner_id TEXT, title TEXT)");
        let alice = OwnerPolicy {
            owner_column: "owner_id",
            subject: "profile:1",
        };
        let bob = OwnerPolicy {
            owner_column: "owner_id",
            subject: "profile:2",
        };

        let (db, _) = apply_with_owner_policy(
            &db,
            "INSERT INTO docs (id, title) VALUES (1, 'alice')",
            alice,
        )
        .unwrap();
        let (db, _) =
            apply_with_owner_policy(&db, "INSERT INTO docs (id, title) VALUES (2, 'bob')", bob)
                .unwrap();

        let (_, alice_rows) =
            apply_with_owner_policy(&db, "SELECT id, owner_id FROM docs", alice).unwrap();
        assert_eq!(
            alice_rows.rows,
            vec![vec![
                SqlValue::Integer(1),
                SqlValue::Text("profile:1".to_string())
            ]]
        );

        let (db, updated) =
            apply_with_owner_policy(&db, "UPDATE docs SET title = 'mine'", alice).unwrap();
        assert_eq!(updated.rows_affected, 1);
        let transfer =
            apply_with_owner_policy(&db, "UPDATE docs SET owner_id = 'profile:2'", alice)
                .unwrap_err();
        assert!(transfer.contains("WITH CHECK"));

        let (db, deleted) = apply_with_owner_policy(&db, "DELETE FROM docs", bob).unwrap();
        assert_eq!(deleted.rows_affected, 1);
        let (_, remaining) = apply(&db, "SELECT id FROM docs").unwrap();
        assert_eq!(remaining.rows, vec![vec![SqlValue::Integer(1)]]);
    }

    #[test]
    fn owner_rls_rejects_spoofed_insert_owner() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE docs (owner_id TEXT)");
        let error = apply_with_owner_policy(
            &db,
            "INSERT INTO docs VALUES ('profile:someone-else')",
            OwnerPolicy {
                owner_column: "owner_id",
                subject: "profile:1",
            },
        )
        .unwrap_err();
        assert!(error.contains("WITH CHECK"));
    }

    #[test]
    fn enforces_primary_unique_not_null_and_types() {
        let db = Database::new();
        let (db, _) = apply_ok(
            &db,
            "CREATE TABLE accounts (id INT PRIMARY KEY, tenant TEXT NOT NULL, email TEXT, UNIQUE (tenant, email))",
        );
        let (db, _) = apply_ok(
            &db,
            "INSERT INTO accounts VALUES (1, 'a', 'one@example.com')",
        );
        assert!(apply(
            &db,
            "INSERT INTO accounts VALUES (1, 'b', 'two@example.com')"
        )
        .unwrap_err()
        .contains("PRIMARY KEY"));
        assert!(apply(&db, "INSERT INTO accounts VALUES (2, NULL, 'x')")
            .unwrap_err()
            .contains("NOT NULL"));
        assert!(
            apply(&db, "INSERT INTO accounts VALUES ('wrong', 'a', 'x')")
                .unwrap_err()
                .contains("Type mismatch")
        );
        let (db, _) = apply_ok(
            &db,
            "INSERT INTO accounts VALUES (2, 'a', 'two@example.com')",
        );
        assert!(apply(
            &db,
            "UPDATE accounts SET email = 'one@example.com' WHERE id = 2"
        )
        .unwrap_err()
        .contains("UNIQUE"));
    }

    #[test]
    fn select_applies_order_limit_offset_and_aliases() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE scores (id INT, score INT)");
        let (db, _) = apply_ok(
            &db,
            "INSERT INTO scores VALUES (1, 20), (2, NULL), (3, 30), (4, 10)",
        );
        let (_, result) = apply_ok(
            &db,
            "SELECT id AS player FROM scores ORDER BY score DESC NULLS LAST LIMIT 2 OFFSET 1",
        );
        assert_eq!(result.columns, vec!["player"]);
        assert_eq!(
            result.rows,
            vec![vec![SqlValue::Integer(1)], vec![SqlValue::Integer(4)]]
        );
    }

    #[test]
    fn rejects_unknown_types_and_unsupported_constraints() {
        let db = Database::new();
        assert!(apply(&db, "CREATE TABLE t (value MAGIC)").is_err());
        assert!(apply(
            &db,
            "CREATE TABLE t (value INT GENERATED ALWAYS AS IDENTITY)"
        )
        .is_err());
    }

    #[test]
    fn scalar_defaults_apply_only_to_omitted_columns() {
        let db = Database::new();
        let (db, _) = apply_ok(
            &db,
            "CREATE TABLE defaults_test (id INT PRIMARY KEY, active BOOLEAN NOT NULL DEFAULT true, label TEXT DEFAULT 'new')",
        );
        let (db, _) = apply_ok(&db, "INSERT INTO defaults_test (id) VALUES (1)");
        let (db, _) = apply_ok(
            &db,
            "INSERT INTO defaults_test (id, active, label) VALUES (2, false, NULL)",
        );
        let (_, result) = apply_ok(&db, "SELECT * FROM defaults_test ORDER BY id");
        assert_eq!(
            result.rows,
            vec![
                vec![
                    SqlValue::Integer(1),
                    SqlValue::Boolean(true),
                    SqlValue::Text("new".to_string())
                ],
                vec![
                    SqlValue::Integer(2),
                    SqlValue::Boolean(false),
                    SqlValue::Null
                ]
            ]
        );
    }

    #[test]
    fn foreign_keys_reject_orphans_and_restrict_parent_changes() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE parents (id INT PRIMARY KEY)");
        let (db, _) = apply_ok(
            &db,
            "CREATE TABLE children (id INT PRIMARY KEY, parent_id INT REFERENCES parents(id))",
        );
        assert!(apply(&db, "INSERT INTO children VALUES (1, 99)")
            .unwrap_err()
            .contains("FOREIGN KEY"));
        let (db, _) = apply_ok(&db, "INSERT INTO parents VALUES (99)");
        let (db, _) = apply_ok(&db, "INSERT INTO children VALUES (1, 99)");
        assert!(apply(&db, "DELETE FROM parents WHERE id = 99")
            .unwrap_err()
            .contains("FOREIGN KEY"));
        assert!(apply(&db, "UPDATE parents SET id = 100 WHERE id = 99")
            .unwrap_err()
            .contains("FOREIGN KEY"));
    }

    #[test]
    fn check_constraints_use_sql_null_semantics() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE products (price INT CHECK (price > 0))");
        let (db, _) = apply_ok(&db, "INSERT INTO products VALUES (NULL), (5)");
        let error = apply(&db, "INSERT INTO products VALUES (0)").unwrap_err();
        assert!(error.contains("CHECK"), "unexpected error: {error}");
    }

    #[test]
    fn alter_table_add_drop_rename_and_defaults_are_atomic() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE people (id INT PRIMARY KEY, name TEXT)");
        let (db, _) = apply_ok(&db, "INSERT INTO people VALUES (1, 'Ada')");
        let (db, _) = apply_ok(
            &db,
            "ALTER TABLE people ADD COLUMN active BOOLEAN NOT NULL DEFAULT true",
        );
        let (db, _) = apply_ok(&db, "ALTER TABLE people RENAME COLUMN name TO display_name");
        let (_, result) = apply_ok(&db, "SELECT display_name, active FROM people");
        assert_eq!(
            result.rows,
            vec![vec![SqlValue::Text("Ada".into()), SqlValue::Boolean(true)]]
        );
        let (db, _) = apply_ok(&db, "ALTER TABLE people DROP COLUMN display_name");
        assert_eq!(db.tables["people"].columns.len(), 2);
    }

    #[test]
    fn foreign_key_cascade_set_null_and_update_cascade_work() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE parents (id INT PRIMARY KEY)");
        let (db, _) = apply_ok(&db, "CREATE TABLE cascade_children (id INT PRIMARY KEY, parent_id INT REFERENCES parents(id) ON UPDATE CASCADE ON DELETE CASCADE)");
        let (db, _) = apply_ok(&db, "CREATE TABLE nullable_children (id INT PRIMARY KEY, parent_id INT REFERENCES parents(id) ON UPDATE CASCADE ON DELETE SET NULL)");
        let (db, _) = apply_ok(&db, "INSERT INTO parents VALUES (1)");
        let (db, _) = apply_ok(&db, "INSERT INTO cascade_children VALUES (1, 1)");
        let (db, _) = apply_ok(&db, "INSERT INTO nullable_children VALUES (1, 1)");
        let (db, _) = apply_ok(&db, "UPDATE parents SET id = 2 WHERE id = 1");
        assert_eq!(
            db.tables["cascade_children"].rows[&1].values[1],
            SqlValue::Integer(2)
        );
        let (db, _) = apply_ok(&db, "DELETE FROM parents WHERE id = 2");
        assert!(db.tables["cascade_children"].rows.is_empty());
        assert_eq!(
            db.tables["nullable_children"].rows[&1].values[1],
            SqlValue::Null
        );
    }

    #[test]
    fn create_index_enforces_unique_and_persists_definition() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE contacts (id INT, email TEXT)");
        let (db, _) = apply_ok(
            &db,
            "CREATE UNIQUE INDEX contacts_email_idx ON contacts (email)",
        );
        let (db, _) = apply_ok(&db, "INSERT INTO contacts VALUES (1, 'a@example.com')");
        assert!(
            apply(&db, "INSERT INTO contacts VALUES (2, 'a@example.com')")
                .unwrap_err()
                .contains("UNIQUE")
        );
        assert_eq!(
            db.tables["contacts"].constraints.indexes[0].name,
            "contacts_email_idx"
        );
        let (db, _) = apply_ok(&db, "DROP INDEX contacts_email_idx");
        assert!(db.tables["contacts"].constraints.indexes.is_empty());
        let error = apply(&db, "DROP VIEW contacts").unwrap_err();
        assert!(error.contains("DROP VIEW"));
        assert!(db.tables.contains_key("contacts"));
    }

    #[test]
    fn inner_and_left_join_resolve_qualified_columns() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE authors (id INT PRIMARY KEY, name TEXT)");
        let (db, _) = apply_ok(&db, "CREATE TABLE books (id INT PRIMARY KEY, author_id INT REFERENCES authors(id), title TEXT)");
        let (db, _) = apply_ok(&db, "INSERT INTO authors VALUES (1, 'Ada'), (2, 'Grace')");
        let (db, _) = apply_ok(&db, "INSERT INTO books VALUES (10, 1, 'Notes')");
        let (_, inner) = apply_ok(
            &db,
            "SELECT a.name, b.title FROM authors a JOIN books b ON a.id = b.author_id",
        );
        assert_eq!(
            inner.rows,
            vec![vec![
                SqlValue::Text("Ada".into()),
                SqlValue::Text("Notes".into())
            ]]
        );
        let (_, left) = apply_ok(&db, "SELECT a.name, b.title FROM authors a LEFT JOIN books b ON a.id = b.author_id ORDER BY a.id");
        assert_eq!(left.rows.len(), 2);
        assert_eq!(
            left.rows[1],
            vec![SqlValue::Text("Grace".into()), SqlValue::Null]
        );
        assert_eq!(
            statement_tables("SELECT * FROM authors JOIN books ON authors.id = books.author_id")
                .unwrap(),
            vec!["authors", "books"]
        );
    }

    #[test]
    fn aggregate_count_sum_avg_min_max_and_group_by() {
        let db = Database::new();
        let (db, _) = apply_ok(&db, "CREATE TABLE sales (region TEXT, amount INT)");
        let (db, _) = apply_ok(
            &db,
            "INSERT INTO sales VALUES ('west', 10), ('west', 20), ('east', 5), ('east', NULL)",
        );
        let (_, result) = apply_ok(&db, "SELECT region, COUNT(amount) AS n, SUM(amount) AS total, AVG(amount) AS average, MIN(amount) AS low, MAX(amount) AS high FROM sales GROUP BY region ORDER BY region");
        assert_eq!(
            result.rows,
            vec![
                vec![
                    SqlValue::Text("east".into()),
                    SqlValue::Integer(1),
                    SqlValue::Integer(5),
                    SqlValue::Float(5.0),
                    SqlValue::Integer(5),
                    SqlValue::Integer(5)
                ],
                vec![
                    SqlValue::Text("west".into()),
                    SqlValue::Integer(2),
                    SqlValue::Integer(30),
                    SqlValue::Float(15.0),
                    SqlValue::Integer(10),
                    SqlValue::Integer(20)
                ],
            ]
        );
    }
}
