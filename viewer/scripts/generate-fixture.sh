#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

duckdb -c "
COPY (
  SELECT
    1 AS id,
    CAST({'xmin': -79.0, 'ymin': 37.5, 'xmax': -78.7, 'ymax': 37.8} AS STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)) AS bbox
  UNION ALL
  SELECT 2, CAST({'xmin': -77.5, 'ymin': 38.8, 'xmax': -77.2, 'ymax': 39.1} AS STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE))
) TO 'scripts/fixture.parquet' (
  FORMAT PARQUET,
  ROW_GROUP_SIZE 1,
  KV_METADATA {
    'geo': '{\"version\":\"1.1.0\",\"primary_column\":\"geometry\",\"columns\":{\"geometry\":{\"encoding\":\"WKB\",\"covering\":{\"bbox\":{\"xmin\":[\"bbox\",\"xmin\"],\"ymin\":[\"bbox\",\"ymin\"],\"xmax\":[\"bbox\",\"xmax\"],\"ymax\":[\"bbox\",\"ymax\"]}}}}}'
  }
);
"
echo "wrote scripts/fixture.parquet"
