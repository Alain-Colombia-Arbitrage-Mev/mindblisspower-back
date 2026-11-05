"""Translate a PostgreSQL URI to explicit libpq fields without logging secrets."""
import json
import os
import sys
from urllib.parse import parse_qs, unquote, urlsplit

try:
    uri = urlsplit(os.environ["DATABASE_URL"])
    query = parse_qs(uri.query, keep_blank_values=True, strict_parsing=True)
    allowed = {"sslmode", "sslrootcert", "sslcert", "sslkey"}
    if uri.scheme not in {"postgres", "postgresql"} or not uri.hostname or not uri.username or uri.fragment:
        raise ValueError()
    if set(query) - allowed or any(len(values) != 1 for values in query.values()):
        raise ValueError()
    fields = {
        "host": unquote(uri.hostname), "port": str(uri.port or 5432),
        "user": unquote(uri.username), "password": unquote(uri.password or ""),
        "database": unquote(uri.path.removeprefix("/")),
        "sslmode": query.get("sslmode", ["verify-full"])[0],
        "sslrootcert": query.get("sslrootcert", [""])[0],
        "sslcert": query.get("sslcert", [""])[0],
        "sslkey": query.get("sslkey", [""])[0],
    }
    if not fields["database"] or any("\x00" in value or "\n" in value or "\r" in value for value in fields.values()):
        raise ValueError()
    json.dump(fields, sys.stdout)
except (ValueError, KeyError):
    sys.exit("Invalid PostgreSQL DATABASE_URL (credentials redacted)")
