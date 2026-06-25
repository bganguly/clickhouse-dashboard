# Dashboard

📺 **Walkthrough video:** https://youtu.be/JcnuVLNKEm0

Bring infra up first, prepare the demo data, then start the dashboard. The
scripts handle the database connection details.

## 1. Bring Infra Up

```bash
./scripts/infra-up.sh
```

This creates or repairs the AWS pieces: VPC, subnets, route table, security
group, and RDS Postgres. It is safe to rerun. It prints each step and an ETA.
It also clears stale dashboard-named RDS leftovers before recreating infra.

Expected infra timing:

- Existing healthy infra: usually under 2 minutes
- New RDS instance: usually 5-10 minutes

## 2. Prepare Demo Data

```bash
npm install
./scripts/prepare-demo-data.sh
```

`prepare-demo-data.sh`:

- Applies the Prisma schema and dashboard SQL migrations
- Seeds the full demo data when the orders table is empty
- Rebuilds the dashboard read models for fast list and chart results
- Prints an ETA, elapsed time, and table-count summary for each major step

Expected demo-data timing on the default `db.m5.xlarge` RDS instance:

- Order seed: progress prints every 500,000-row batch
- Order-item seed: similar batch progress after orders finish
- Full prepare run: usually about 12-20 minutes end to end

You can change seed batch size for more or fewer progress updates:

```bash
SEED_BATCH_SIZE=1000000 ./scripts/prepare-demo-data.sh
```

### Fast path: restore from a pre-baked snapshot (maintainer only)

Seeding + rebuilding takes ~15-20 minutes. To make demos quick, a maintainer can
bake the prepared database into a `pg_dump` snapshot stored in a **private** S3
object (Standard-IA) under their own AWS credentials, then restore from it in a
few minutes.

The helper scripts run **on your local terminal**:

```bash
# bake the current database into a private S3 snapshot
DEMO_SNAPSHOT_S3_URI=s3://<your-private-bucket>/dash/demo.dump ./scripts/bake-demo-snapshot.sh

# later, restore from it instead of re-seeding
DEMO_SNAPSHOT_S3_URI=s3://<your-private-bucket>/dash/demo.dump ./scripts/prepare-demo-data.sh
```

The bucket is private. A developer cloning from GitHub has no access to it and
no `DEMO_SNAPSHOT_S3_URI` set, so they transparently fall back to the full seed
path — nothing to configure.

#### In-region bake/restore (fastest — avoids the local network entirely)

The dump/restore moves several GB between the database and your machine. Run
locally, every byte crosses your home/office link, which dominates the time.
Running the same steps **inside the RDS region** (e.g. AWS CloudShell in
`us-east-1`) keeps the traffic on AWS's internal network, turning a ~1 hour pull
into a few minutes.

> The RDS security group typically allows only your local IP on port 5432, so
> CloudShell must temporarily allow its own egress IP, then revoke it when done.
> Get the live `DATABASE_URL` from `./scripts/database-url.sh` on your **local
> terminal** and paste it into CloudShell — never commit the credentialed URL.

Run all of the following **in AWS CloudShell (same region as RDS):**

```bash
# one-time: install a Postgres client that matches the server major version
sudo dnf install -y postgresql16

# allow CloudShell's current IP to reach RDS (harmless if the rule already exists)
MYIP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id <rds-security-group-id> \
  --protocol tcp --port 5432 --cidr ${MYIP}/32 2>/dev/null || true

export BUCKET=<your-private-bucket>
export DATABASE_URL='<paste from ./scripts/database-url.sh>'

# --- BAKE: stream the dump straight to S3 (no local file; bypasses the 1 GB home limit) ---
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | aws s3 cp - "s3://$BUCKET/dash/demo.dump" --storage-class STANDARD_IA

# --- RESTORE: download in-region, then parallel restore (-j builds indexes concurrently) ---
aws s3 cp "s3://$BUCKET/dash/demo.dump" ~/demo.dump
pg_restore --no-owner --no-privileges --clean --if-exists --jobs 4 \
  --dbname "$DATABASE_URL" ~/demo.dump
rm -f ~/demo.dump

# close the hole again when finished
aws ec2 revoke-security-group-ingress --group-id <rds-security-group-id> \
  --protocol tcp --port 5432 --cidr ${MYIP}/32
```

`pg_restore --clean --if-exists` drops and recreates the demo objects, so it
overwrites the current contents of the target database — intended for refreshing
a demo, destructive otherwise.

## 3. Start Dashboard On 3004

```bash
./scripts/start-dashboard.sh
```

`start-dashboard.sh` loads the database connection details (`DATABASE_URL`)
first, then starts the combined dashboard backend and UI at
http://localhost:3004.

## 4. Start Quick Order On 3005

Quick Order is a separate repo pushed to `bganguly/websockets-quickorder`.

```bash
cd ../websockets-quickorder
npm install
BACKEND_URL=http://localhost:3004 npm run dev
```

Open http://localhost:3005.

Creating an order in Quick Order should move the new row to the top of the
dashboard list and refresh the aggregates through SSE.

## 5. Verify Automatically With Playwright

```bash
npm run lint
npm run build
```

With the dashboard running:

```bash
BASE_URL=http://localhost:3004 BACKEND_URL=http://localhost:3004 npx playwright test
```

## 6. Important: Tear Down Infra

```bash
./scripts/infra-down.sh
```

This destroys the AWS resources and removes `.env.rds`.
