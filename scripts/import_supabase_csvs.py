#!/usr/bin/env python3
"""Import Supabase Table Editor CSV dumps into self-hosted Postgres."""
from __future__ import annotations

import csv
import json
import os
import re
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

CSV_DIR = Path(os.environ.get("CSV_DIR", "/opt/supabase/csv-import"))
DSN = os.environ["DATABASE_URL"]

# table -> csv filename
TABLE_FILES = {
    "teams": "teams_rows.csv",
    "business_numbers": "business_numbers_rows.csv",
    "role_permissions": "role_permissions_rows.csv",
    "agent_targets_role": "agent_targets_role_rows.csv",
    "app_settings": "app_settings_rows.csv",
    "system_settings": "system_settings_rows.csv",
    "team_members": "team_members_rows.csv",
    "team_member_permissions": "team_member_permissions_rows.csv",
    "contacts": "contacts_rows.csv",
    "messages": "messages_rows.csv",
    "automation_configs": "automation_configs_rows.csv",
    "automation_logs": "automation_logs_rows.csv",
    "campaigns": "campaigns_rows.csv",
    "bookings": "bookings_rows.csv",
    "payments": "payments_rows.csv",
    "tasks": "tasks_rows.csv",
    "task_comments": "task_comments_rows.csv",
    "drip_campaigns": "drip_campaigns_rows.csv",
    "drip_steps": "drip_steps_rows.csv",
    "knowledge_chunks": "knowledge_chunks_rows.csv",
    "lead_distribution_config": "lead_distribution_config_rows.csv",
    "lead_distribution_pending": "lead_distribution_pending_rows.csv",
    "lsq_webhook_events": "lsq_webhook_events_rows.csv",
    "quick_replies": "quick_replies_rows.csv",
    "trigger_flows": "trigger_flows_rows.csv",
    "trigger_nodes": "trigger_nodes_rows.csv",
    "trigger_edges": "trigger_edges_rows.csv",
    "trigger_runs": "trigger_runs_rows.csv",
    "trigger_run_vars": "trigger_run_vars_rows.csv",
    "user_activity_days": "user_activity_days_rows.csv",
    "user_sessions": "user_sessions_rows.csv",
    "whatsapp_calls": "whatsapp_calls_rows.csv",
    "evolution_disconnects": "evolution_disconnects_rows.csv",
}

IMPORT_ORDER = list(TABLE_FILES.keys())

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def empty_to_none(v: str | None):
    if v is None:
        return None
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


def adapt_value(raw: str | None, udt: str, data_type: str):
    v = empty_to_none(raw)
    if v is None:
        return None

    if udt.endswith("[]") or data_type == "ARRAY":
        # Supabase CSV uses JSON arrays: [] or ["a","b"]
        try:
            parsed = json.loads(v)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
        # Already PG style {a,b}
        return v

    if udt in ("json", "jsonb") or data_type in ("json", "jsonb"):
        try:
            return psycopg2.extras.Json(json.loads(v))
        except Exception:
            return psycopg2.extras.Json(v)

    if udt == "bool" or data_type == "boolean":
        return str(v).lower() in ("true", "t", "1", "yes")

    if udt in ("int2", "int4", "int8") or data_type.startswith("integer") or data_type == "bigint":
        try:
            return int(v)
        except Exception:
            return None

    if udt in ("float4", "float8", "numeric") or data_type in ("numeric", "real", "double precision"):
        try:
            return float(v)
        except Exception:
            return None

    if udt == "uuid":
        return v if UUID_RE.match(v) else None

    return v


def table_columns(cur, table: str) -> dict[str, tuple[str, str]]:
    cur.execute(
        """
        SELECT column_name, udt_name, data_type
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name=%s
        """,
        (table,),
    )
    return {r[0]: (r[1], r[2]) for r in cur.fetchall()}


def ensure_columns(cur, table: str, csv_cols: list[str], existing: dict):
    """Add missing columns as text so import can proceed; types can be refined later."""
    for col in csv_cols:
        if col not in existing:
            print(f"  ADD COLUMN {table}.{col} text")
            cur.execute(f'ALTER TABLE public."{table}" ADD COLUMN IF NOT EXISTS "{col}" text')
            existing[col] = ("text", "text")


def seed_auth_users(cur, team_csv: Path):
    if not team_csv.exists():
        print("No team_members CSV; skip auth seed")
        return 0
    with team_csv.open("r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    n = 0
    for row in rows:
        uid = empty_to_none(row.get("user_id"))
        email = empty_to_none(row.get("email"))
        if not uid or not email:
            continue
        cur.execute("SELECT 1 FROM auth.users WHERE id=%s", (uid,))
        if cur.fetchone():
            continue
        cur.execute(
            """
            INSERT INTO auth.users (
              instance_id, id, aud, role, email, encrypted_password,
              email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
              created_at, updated_at, is_super_admin,
              confirmation_token, recovery_token, email_change_token_new, email_change
            ) VALUES (
              '00000000-0000-0000-0000-000000000000',
              %s, 'authenticated', 'authenticated', %s,
              crypt(%s, gen_salt('bf')),
              now(),
              '{"provider":"email","providers":["email"]}'::jsonb,
              '{}'::jsonb,
              now(), now(), false,
              '', '', '', ''
            )
            ON CONFLICT (id) DO NOTHING
            """,
            (uid, email.lower(), "ChangeMe-Temp-2026!"),
        )
        # identity for email provider
        cur.execute(
            """
            INSERT INTO auth.identities (
              id, user_id, identity_data, provider, provider_id,
              last_sign_in_at, created_at, updated_at
            ) VALUES (
              %s, %s,
              jsonb_build_object('sub', %s::text, 'email', %s),
              'email', %s,
              now(), now(), now()
            )
            ON CONFLICT DO NOTHING
            """,
            (uid, uid, uid, email.lower(), uid),
        )
        n += 1
    print(f"Seeded auth.users/identities: {n}")
    return n


def import_table(cur, table: str, path: Path, batch_size: int = 500):
    if not path.exists():
        print(f"SKIP missing {path.name}")
        return 0
    cols_meta = table_columns(cur, table)
    if not cols_meta:
        print(f"SKIP no table public.{table}")
        return 0

    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        csv_cols = reader.fieldnames or []
        ensure_columns(cur, table, csv_cols, cols_meta)
        # refresh after alters
        cols_meta = table_columns(cur, table)
        use_cols = [c for c in csv_cols if c in cols_meta]
        if not use_cols:
            print(f"SKIP {table}: no overlapping columns")
            return 0

        placeholders = ",".join(["%s"] * len(use_cols))
        col_sql = ",".join(f'"{c}"' for c in use_cols)
        # Prefer DO NOTHING on conflict if PK exists; else plain insert
        insert_sql = f'INSERT INTO public."{table}" ({col_sql}) VALUES ({placeholders}) ON CONFLICT DO NOTHING'

        batch = []
        total = 0
        for row in reader:
            vals = []
            for c in use_cols:
                udt, dtype = cols_meta[c]
                vals.append(adapt_value(row.get(c), udt, dtype))
            batch.append(vals)
            if len(batch) >= batch_size:
                try:
                    psycopg2.extras.execute_batch(cur, insert_sql, batch, page_size=batch_size)
                except Exception:
                    # fallback row-by-row to skip bad rows
                    for b in batch:
                        try:
                            cur.execute(insert_sql, b)
                            total += 1
                        except Exception as e:
                            cur.connection.rollback()
                            # reopen transaction
                            print(f"  row fail {table}: {e}")
                            raise
                    batch = []
                    continue
                total += len(batch)
                batch = []
                if total and total % 5000 == 0:
                    print(f"  {table}: {total}...")
                    cur.connection.commit()
        if batch:
            psycopg2.extras.execute_batch(cur, insert_sql, batch, page_size=batch_size)
            total += len(batch)
    print(f"OK {table}: {total}")
    return total


def main():
    csv.field_size_limit(min(sys.maxsize, 50 * 1024 * 1024))
    conn = psycopg2.connect(DSN)
    conn.autocommit = False
    cur = conn.cursor()
    try:
        # extensions for crypt
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        conn.commit()

        # defer FKs where possible
        cur.execute("SET session_replication_role = replica")  # disable triggers/FK checks
        seed_auth_users(cur, CSV_DIR / "team_members_rows.csv")
        conn.commit()

        for table in IMPORT_ORDER:
            path = CSV_DIR / TABLE_FILES[table]
            print(f"== {table} ==")
            try:
                import_table(cur, table, path)
                conn.commit()
            except Exception as e:
                conn.rollback()
                cur.execute("SET session_replication_role = replica")
                print(f"FAIL {table}: {e}")
                # continue with other tables
                continue

        cur.execute("SET session_replication_role = DEFAULT")
        conn.commit()

        print("\n=== COUNTS ===")
        for table in IMPORT_ORDER + ["auth.users"]:
            try:
                if table == "auth.users":
                    cur.execute("SELECT count(*) FROM auth.users")
                else:
                    cur.execute(f'SELECT count(*) FROM public."{table}"')
                print(f"{table}={cur.fetchone()[0]}")
            except Exception as e:
                conn.rollback()
                print(f"{table}=ERR {e}")
        conn.commit()
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
