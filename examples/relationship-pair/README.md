# Example: two related DMOs with a foreign key

**Use when** the user wants to model a parent/child relationship
between two custom DMOs — e.g. transactions referencing accounts,
orders referencing products. Required for cross-DMO queries and
joins in Data Cloud.

## What this deploys

Two parallel ingest pipelines + a `Relationship` between the
resulting DMOs:

```
S3 (accounts.csv) → Stream → DLO → AccountDMO → Mapping
S3 (orders.csv)   → Stream → DLO → OrderDMO   → Mapping
                                       ↓
                              Relationship (orders.AccountId → accounts.Id)
```

## What the user provides

- `targetOrg`.
- AWS creds.
- Two CSV files, one for each DMO. Each CSV must include the FK
  column on the child side (e.g. `accounts.csv` has `Id`,
  `orders.csv` has `Id` + `AccountId`).
- DMO field sets for both DMOs.

## What's defaulted

- `cardinality: "ManyToOne"` — orders → accounts (many orders point
  at one account). Switch to `"OneToOne"` only when the FK is
  unique-constrained.
- `relationshipOwner: "DataCloud"` — for custom DMOs. Use `"Sobject"`
  only when the relationship comes from a Salesforce CRM lookup
  field (rare in this scenario).

## Critical preconditions

Both DMOs must be **mapped** (have at least one DLO→DMO mapping)
before the relationship deploys. afd360 auto-orders this via
`dependsOn`, but if the user authors the Relationship before either
mapping is in place at deploy time, the API rejects with `400
INVALID_INPUT: No ObjectSourceTargetMaps were found`.

## Adapt this

The example is two-parallel-S3-streams. Other shapes work — Snowflake
parent + S3 child, IngestApi parent + S3 child, etc. The Relationship
construct doesn't care about the source connector; it only references
the two DMOs.

For a relationship to a *standard* DMO (`ssot__Account__dlm`,
`ssot__Case__dlm`, etc.), use the dev name string instead of a
construct reference: `target: "ssot__Account__dlm"`. The standard DMO
is mapped automatically by the platform's bundle streams.
