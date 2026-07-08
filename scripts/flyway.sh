#!/usr/bin/env bash
# Flyway wrapper: translates DATABASE_URL (postgres:// URI, same env the app
# uses) into JDBC connection flags and runs the pinned Flyway CLI, downloading
# it on first use (no Docker/Java prerequisites — the CLI tarball bundles a JRE).
#
# Usage: scripts/flyway.sh <migrate|info|validate|baseline|repair> [flags...]
#   npm run db:apply     → migrate
#   npm run db:info      → info
#   npm run db:baseline  → baseline (one-time on pre-Flyway databases)
set -euo pipefail

FLYWAY_VERSION="${FLYWAY_VERSION:-10.22.0}"
CACHE_DIR="${FLYWAY_CACHE_DIR:-$HOME/.cache/seazn-flyway}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

# --- Resolve the Flyway CLI (download + cache per version/platform) ----------
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PLATFORM="linux-x64" ;;
  Linux-aarch64) PLATFORM="linux-alpine-x64" ;; # no arm build; alpine works on most
  Darwin-arm64)  PLATFORM="macosx-arm64" ;;
  Darwin-x86_64) PLATFORM="macosx-x64" ;;
  *) echo "Unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

FLYWAY_HOME="$CACHE_DIR/flyway-$FLYWAY_VERSION-$PLATFORM"
FLYWAY_BIN="$FLYWAY_HOME/flyway"
if [[ ! -x "$FLYWAY_BIN" ]]; then
  mkdir -p "$CACHE_DIR"
  TARBALL="flyway-commandline-$FLYWAY_VERSION-$PLATFORM.tar.gz"
  URL="https://download.red-gate.com/maven/release/com/redgate/flyway/flyway-commandline/$FLYWAY_VERSION/$TARBALL"
  echo "Downloading Flyway CLI $FLYWAY_VERSION ($PLATFORM)…" >&2
  curl -fsSL "$URL" -o "$CACHE_DIR/$TARBALL"
  mkdir -p "$FLYWAY_HOME"
  tar -xzf "$CACHE_DIR/$TARBALL" -C "$FLYWAY_HOME" --strip-components=1
  rm -f "$CACHE_DIR/$TARBALL"
fi

# --- DATABASE_URL (postgres://) → JDBC flags ---------------------------------
# node handles URI decoding (passwords with special chars) — no fragile sed.
eval "$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  const db = u.pathname.replace(/^\//, "") || "postgres";
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  const sslEnv = process.env.DATABASE_SSL;
  const ssl = sslEnv === "disable" ? false : sslEnv === "require" ? true : !local;
  // Pin the session search_path to the target schema ONLY (public excluded) so
  // the v1-baseline migrations unqualified `drop table … cascade` can never
  // reach a populated public schema. Critical when seazn_club shares a database
  // with an existing public (e.g. Supabase).
  const schema = process.env.DB_SCHEMA || "seazn_club";
  const qp = [ssl ? "sslmode=require" : null, `options=-c%20search_path%3D${schema}`]
    .filter(Boolean).join("&");
  const params = qp ? "?" + qp : "";
  const q = (s) => "'\''" + s.replace(/'\''/g, "'\''\\'\'''\''") + "'\''";
  console.log("JDBC_URL=" + q(`jdbc:postgresql://${u.hostname}:${u.port || 5432}/${db}${params}`));
  console.log("DB_USER=" + q(decodeURIComponent(u.username)));
  console.log("DB_PASS=" + q(decodeURIComponent(u.password)));
')"

# The app lives in a dedicated schema (not public). Pass it as CLI flags so it
# also becomes ${flyway:defaultSchema} in migrations. Override with DB_SCHEMA.
DB_SCHEMA="${DB_SCHEMA:-seazn_club}"

exec "$FLYWAY_BIN" \
  -configFiles="$REPO_ROOT/db/flyway.toml" \
  -workingDirectory="$REPO_ROOT" \
  -url="$JDBC_URL" \
  -user="$DB_USER" \
  -password="$DB_PASS" \
  -schemas="$DB_SCHEMA" \
  -defaultSchema="$DB_SCHEMA" \
  "$@"
