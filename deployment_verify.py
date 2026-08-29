from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


UNIQUE_CHECKS = {
    "questionnaires.session_id": "SELECT COUNT(*) FROM (SELECT session_id FROM questionnaires GROUP BY session_id HAVING COUNT(*) > 1)",
    "post_task_surveys.session_id": "SELECT COUNT(*) FROM (SELECT session_id FROM post_task_surveys GROUP BY session_id HAVING COUNT(*) > 1)",
    "pre_task_surveys.participant_id": "SELECT COUNT(*) FROM (SELECT participant_id FROM pre_task_surveys GROUP BY participant_id HAVING COUNT(*) > 1)",
}

ORPHAN_CHECKS = {
    "sessions.participant_id": "SELECT COUNT(*) FROM sessions child LEFT JOIN participants parent ON parent.id = child.participant_id WHERE parent.id IS NULL",
    "questionnaires.session_id": "SELECT COUNT(*) FROM questionnaires child LEFT JOIN sessions parent ON parent.id = child.session_id WHERE parent.id IS NULL",
    "post_task_surveys.session_id": "SELECT COUNT(*) FROM post_task_surveys child LEFT JOIN sessions parent ON parent.id = child.session_id WHERE parent.id IS NULL",
    "pre_task_surveys.participant_id": "SELECT COUNT(*) FROM pre_task_surveys child LEFT JOIN participants parent ON parent.id = child.participant_id WHERE parent.id IS NULL",
    "chat_logs.session_id": "SELECT COUNT(*) FROM chat_logs child LEFT JOIN sessions parent ON parent.id = child.session_id WHERE parent.id IS NULL",
    "expression_frames.session_id": "SELECT COUNT(*) FROM expression_frames child LEFT JOIN sessions parent ON parent.id = child.session_id WHERE parent.id IS NULL",
    "evaluations.session_id": "SELECT COUNT(*) FROM evaluations child LEFT JOIN sessions parent ON parent.id = child.session_id WHERE parent.id IS NULL",
    "session_events.session_id": "SELECT COUNT(*) FROM session_events child LEFT JOIN sessions parent ON parent.id = child.session_id WHERE parent.id IS NULL",
}

REQUIRED_UNIQUE_INDEXES = {
    "questionnaires": ("session_id",),
    "post_task_surveys": ("session_id",),
    "pre_task_surveys": ("participant_id",),
}


def file_metadata(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"path": str(path), "exists": False}
    stat = path.stat()
    return {
        "path": str(path),
        "exists": True,
        "size": stat.st_size,
        "modified_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    }


def scalar(connection: sqlite3.Connection, sql: str) -> int:
    return int(connection.execute(sql).fetchone()[0])


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def has_unique_index(connection: sqlite3.Connection, table: str, columns: tuple[str, ...]) -> bool:
    for row in connection.execute(f"PRAGMA index_list({quote_identifier(table)})").fetchall():
        index_name = str(row[1])
        is_unique = bool(row[2])
        if not is_unique:
            continue
        index_columns = tuple(
            str(index_row[2])
            for index_row in connection.execute(
                f"PRAGMA index_info({quote_identifier(index_name)})"
            ).fetchall()
        )
        if index_columns == columns:
            return True
    return False


def collect_report(db_path: Path, stage: str) -> dict[str, Any]:
    related_files = [db_path, Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")]
    before_files = [file_metadata(path) for path in related_files]
    uri = f"file:{db_path.resolve().as_posix()}?mode=ro"

    with sqlite3.connect(uri, uri=True, timeout=30) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        table_rows = connection.execute(
            "SELECT name, sql FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        table_names = {name for name, _ in table_rows}
        schema = {name: sql for name, sql in table_rows}
        row_counts = {
            name: scalar(connection, f"SELECT COUNT(*) FROM {quote_identifier(name)}")
            for name in sorted(table_names)
        }
        quick_check = [row[0] for row in connection.execute("PRAGMA quick_check").fetchall()]
        foreign_key_violations = [list(row) for row in connection.execute("PRAGMA foreign_key_check").fetchall()]
        unique_violations = {
            name: scalar(connection, sql)
            for name, sql in UNIQUE_CHECKS.items()
            if name.split(".", 1)[0] in table_names
        }
        orphan_rows = {
            name: scalar(connection, sql)
            for name, sql in ORPHAN_CHECKS.items()
            if name.split(".", 1)[0] in table_names
        }
        required_unique_indexes = {
            f"{table}({','.join(columns)})": has_unique_index(connection, table, columns)
            for table, columns in REQUIRED_UNIQUE_INDEXES.items()
            if table in table_names
        }
        content_digest = hashlib.sha256()
        for line in connection.iterdump():
            content_digest.update(line.encode("utf-8"))
            content_digest.update(b"\n")

    summary = {
        "schema": schema,
        "row_counts": row_counts,
        "quick_check": quick_check,
        "foreign_key_violation_count": len(foreign_key_violations),
        "unique_violations": unique_violations,
        "required_unique_indexes": required_unique_indexes,
        "orphan_rows": orphan_rows,
    }
    summary_json = json.dumps(summary, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    ok = (
        quick_check == ["ok"]
        and not foreign_key_violations
        and all(count == 0 for count in unique_violations.values())
        and all(required_unique_indexes.values())
        and all(count == 0 for count in orphan_rows.values())
    )
    return {
        "ok": ok,
        "stage": stage,
        "collected_utc": datetime.now(timezone.utc).isoformat(),
        "computer_name": platform.node(),
        "database": str(db_path.resolve()),
        "read_only": True,
        "process_id": os.getpid(),
        "files_before_check": before_files,
        "files_after_check": [file_metadata(path) for path in related_files],
        "content_sha256": content_digest.hexdigest(),
        "summary_sha256": hashlib.sha256(summary_json.encode("utf-8")).hexdigest(),
        **summary,
        "foreign_key_violations": foreign_key_violations[:100],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only PyFeat deployment database verification")
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--stage", required=True, choices=("before", "after"))
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    output_path = args.output

    if not args.db.is_file():
        report = {
            "ok": False,
            "stage": args.stage,
            "collected_utc": datetime.now(timezone.utc).isoformat(),
            "database": str(args.db),
            "error": "database_not_found",
        }
    else:
        try:
            report = collect_report(args.db, args.stage)
            if args.stage == "after":
                if args.baseline and args.baseline.is_file():
                    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
                    content_matches = report.get("content_sha256") == baseline.get("content_sha256")
                    summary_matches = report.get("summary_sha256") == baseline.get("summary_sha256")
                    report["comparison_to_before"] = {
                        "report": str(args.baseline),
                        "content_matches": content_matches,
                        "summary_matches": summary_matches,
                    }
                    report["ok"] = bool(report.get("ok") and content_matches and summary_matches)
                else:
                    report["comparison_to_before"] = {"error": "baseline_report_not_found"}
                    report["ok"] = False
        except Exception as exc:
            report = {
                "ok": False,
                "stage": args.stage,
                "collected_utc": datetime.now(timezone.utc).isoformat(),
                "database": str(args.db),
                "error_type": type(exc).__name__,
                "error": str(exc),
            }

    output_path.write_text(json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8")
    print(f"Database verification report: {output_path}")
    print(f"Database verification ok: {report.get('ok', False)}")
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
