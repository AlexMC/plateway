#!/bin/sh
# Local staging only (compose.local.yml): MinIO set up as R2 is (docs/operations.md, "R2"). Three buckets, the
# packages bucket's 7-day lifecycle rule and CORS rule, a public-read library, and one user per container holding only
# what that container needs. Safe to run again.
set -eu

mc alias set local http://minio:9900 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

for bucket in plateway-packages plateway-library plateway-backups; do
  mc mb --ignore-existing "local/$bucket"
done

cat > /tmp/packages-lifecycle.json <<'JSON'
{"Rules": [{"ID": "expire-after-7-days", "Status": "Enabled", "Filter": {"Prefix": ""}, "Expiration": {"Days": 7}}]}
JSON
mc ilm import local/plateway-packages < /tmp/packages-lifecycle.json
mc anonymous set download local/plateway-library

# Test drive fetches inspection meshes through presigned packages links, a cross-origin fetch from the app.
cat > /tmp/packages-cors.xml <<'XML'
<CORSConfiguration><CORSRule><AllowedOrigin>http://127.0.0.1:8890</AllowedOrigin>
<AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader></CORSRule>
</CORSConfiguration>
XML
# Community MinIO answers NotImplemented to bucket CORS and allows every origin; a release that has it enforces the rule.
mc cors set local/plateway-packages /tmp/packages-cors.xml 2>/dev/null ||
  echo "plateway-packages: this MinIO has no bucket CORS and allows every origin"

# api: presign, stream and purge packages; write the library.
cat > /tmp/api.json <<'JSON'
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["s3:GetObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::plateway-packages/*"]},
  {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
   "Resource": ["arn:aws:s3:::plateway-library/*"]},
  {"Effect": "Allow", "Action": ["s3:ListBucket"],
   "Resource": ["arn:aws:s3:::plateway-packages", "arn:aws:s3:::plateway-library"]}]}
JSON
# worker: read and write packages.
cat > /tmp/worker.json <<'JSON'
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
   "Resource": ["arn:aws:s3:::plateway-packages/*"]},
  {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::plateway-packages"]}]}
JSON
# litestream: the backups bucket only.
cat > /tmp/litestream.json <<'JSON'
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
   "Resource": ["arn:aws:s3:::plateway-backups/*"]},
  {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": ["arn:aws:s3:::plateway-backups"]}]}
JSON

grant() {
  mc admin policy create local "plateway-$1" "/tmp/$1.json" >/dev/null
  mc admin user add local "$2" "$3" >/dev/null
  mc admin policy attach local "plateway-$1" --user "$2" >/dev/null 2>&1 || true
  echo "user $2: policy plateway-$1"
}
grant api "$API_R2_ACCESS_KEY_ID" "$API_R2_SECRET_ACCESS_KEY"
grant worker "$WORKER_R2_ACCESS_KEY_ID" "$WORKER_R2_SECRET_ACCESS_KEY"
grant litestream "$LITESTREAM_R2_ACCESS_KEY_ID" "$LITESTREAM_R2_SECRET_ACCESS_KEY"
