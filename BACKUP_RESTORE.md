# BestoDine backup and restore runbook

Goal: if the production database is lost, corrupted or wrongly deleted, you can get the data back, and you have PROVEN you can, recently.

A backup you have never restored is a hope, not a backup. The restore drill (section 5) matters as much as the backup.

First find out which path you are on. In Atlas, open the cluster. If it says **M0**, **M2** or **M5** (free or shared), use **Path B**. If it says **M10** or higher (Flex clusters: check the Backup tab; Flex has limited snapshots), use **Path A**, and you may still add Path B as a second copy.

Existing app feature: the in-app tenant export (`controllers/tenantBackupController.js`) exports ONE restaurant's data. It is not a disaster-recovery backup of the whole database.

---

## Path A: Atlas Cloud Backup (M10 and above)

### A1. Turn it on
1. Atlas, choose the project, then the cluster, then the **Backup** tab.
2. Click **Enable Cloud Backup** (on M10+ it is a checkbox when editing the cluster, costs extra storage per GB).
3. Open **Edit Backup Policy** and set:
   - Snapshots: every 6 or 12 hours, plus daily.
   - Retention: daily kept 7 to 14 days, weekly 4 weeks, monthly 6 to 12 months.
4. Strongly recommended: enable **Continuous Cloud Backup** (point-in-time restore). Set the restore window (for example 7 days). This lets you restore to "10 minutes before someone deleted the orders collection".
5. Optional: turn on **Copy snapshots to another region** so a regional outage cannot take both data and backups.

### A2. Restore a snapshot (to a NEW cluster, never over production first)
1. Backup tab, **Snapshots**, pick the snapshot (or **Point in Time**), click **Restore**.
2. Choose **Restore to another cluster**, and create or pick a scratch cluster. Do NOT choose "Restore to this cluster" unless production is already lost; it replaces everything.
3. Wait for the restore to finish, then check counts (section 5, step 6) against the scratch cluster.
4. For a real disaster: point the app's `MONGO_URL` at the restored cluster (or restore into the original cluster once you have verified). Restart the backend.
5. Remember Atlas Project IP access list and database users are NOT in a snapshot; recreate them on the new cluster.

### A3. Still do a drill
Restore a snapshot to a scratch cluster at least every quarter, check counts, record it in section 6, then delete the scratch cluster (it bills by the hour).

---

## Path B: free or shared tier (M0 / M2 / M5): scheduled mongodump

M0/M2/M5 have no Cloud Backup. Atlas does not give you snapshots there, so you must take your own dump. (M0 also cannot be used with some mongodump features; if mongodump errors, upgrade the tier, that is the real fix.)

### B1. One-time setup
1. Install the **MongoDB Database Tools** (https://www.mongodb.com/try/download/database-tools). Check: `mongodump --version`.
2. In Atlas create a separate **read-only** database user for backups: Database Access, Add User, built-in role **backup** (or **read** on the production database). Never reuse the app's user.
3. Allow the backup machine's IP in Atlas Network Access.
4. Pick a backup folder that is NOT synced by OneDrive and NOT inside the project, for example `D:\bestodine-backups` (Windows) or `/var/backups/bestodine` (Linux). OneDrive would upload database dumps containing customer data to a cloud account and may lock files mid-write.
5. Make the credentials available only to the scheduled job (not committed, not in the project `.env`):

   - `BACKUP_MONGO_URI` : full `mongodb+srv://backup_user:URL-ENCODED-PASSWORD@cluster.xxxx.mongodb.net/bestodine`
   - `BACKUP_DIR` : the folder above
   - `BACKUP_RETENTION_DAYS` : optional, default 14

### B2. Run it by hand first
```
cd Backend
node scripts/backup-mongodump.js --dry-run     # prints the plan, connects to nothing
node scripts/backup-mongodump.js               # real run
```
It writes `bestodine-<UTC timestamp>.archive.gz` (written as `.partial` and renamed only on success), deletes archives older than the retention, prints nothing secret, and exits non-zero on failure (so a scheduler can alert on it).

### B3. How often
- Minimum: once a day, at a quiet hour (for example 03:30).
- If you can lose at most a few hours of orders: every 6 hours.
- Keep at least 14 days; keep one copy a month for a year if storage allows (copy it aside before pruning removes it).
- Alert if the newest archive is older than 36 hours (see B6).

### B4. Windows Task Scheduler example
Create `D:\bestodine-backups\run-backup.cmd` (outside the project, so the secret is not in the repo):
```
@echo off
set BACKUP_MONGO_URI=mongodb+srv://backup_user:URL-ENCODED-PASSWORD@cluster.xxxx.mongodb.net/bestodine
set BACKUP_DIR=D:\bestodine-backups\archives
set BACKUP_RETENTION_DAYS=14
cd /d C:\path\to\BestoDine\Backend
node scripts\backup-mongodump.js >> D:\bestodine-backups\backup.log 2>&1
```
Restrict that file to your own Windows user (right click, Properties, Security). Register the task (run in an elevated PowerShell):
```
schtasks /Create /TN "BestoDine Backup" /TR "D:\bestodine-backups\run-backup.cmd" /SC DAILY /ST 03:30 /RL HIGHEST
```
In Task Scheduler, tick "Run whether user is logged on or not" and "Run task as soon as possible after a scheduled start is missed". The PC must be on; a laptop that sleeps will skip backups, so prefer an always-on machine or a small server.

### B5. cron example (Linux server)
`/etc/bestodine-backup.env` (chmod 600, owner the cron user):
```
BACKUP_MONGO_URI=mongodb+srv://backup_user:URL-ENCODED-PASSWORD@cluster.xxxx.mongodb.net/bestodine
BACKUP_DIR=/var/backups/bestodine
BACKUP_RETENTION_DAYS=14
```
`crontab -e`:
```
30 3 * * *  set -a; . /etc/bestodine-backup.env; set +a; cd /opt/bestodine/Backend && node scripts/backup-mongodump.js >> /var/log/bestodine-backup.log 2>&1
```

### B6. Off-site copy, encryption, monitoring
- A backup on the same disk or machine as the only other copy is not enough. Copy archives to a second place: an S3-compatible bucket (`aws s3 cp` or `rclone copy` run after the backup in the same scheduled script), or an external drive kept elsewhere. The script has a TODO hook for upload (no AWS SDK is installed in this project, none was added).
- Encryption: archives contain customer names, phones and order history. Keep them on an encrypted disk (BitLocker on Windows, LUKS on Linux) and use bucket server-side encryption for uploads. If you must store them on a shared or unencrypted medium, encrypt first, for example `7z a -p -mhe=on file.7z archive.gz` or `gpg --symmetric --cipher-algo AES256 archive.gz`. Store the passphrase separately from the archive, in your password manager; without it the backup is useless.
- Monitoring: add a second scheduled check that fails or emails when no `bestodine-*.archive.gz` newer than 36 hours exists in `BACKUP_DIR`. Also check the log for failures.
- The backup user's password is passed to `mongodump` as a command line argument, so it is visible to other local users in the process list for the duration of the run. Run on a machine only you control.

---

## 5. Restore drill (do it monthly; the first one now)

Never restore over production. The script refuses any target database not named `restore_drill_*` or `bestodine_staging*`, and refuses the production database name.

Where to restore: a scratch MongoDB (for example the local staging mongod from `STAGING.md`: `npm run db:staging`, then URI `mongodb://127.0.0.1:27018`), or a scratch Atlas cluster/project. Do NOT point at the production cluster.

Steps:
1. Pick the newest archive (or an old one to test retention).
2. Set the target (PowerShell example; use `export` in bash):
   ```
   $env:RESTORE_TARGET_URI = "mongodb://127.0.0.1:27018"
   $env:RESTORE_TARGET_DB  = "restore_drill_20261028"
   $env:RESTORE_SOURCE_DB  = "bestodine"      # the database name inside the archive
   ```
   Optionally set `PRODUCTION_DB_NAME` too; the script also refuses names found in `BACKUP_MONGO_URI` and `MONGO_URL` if set.
3. Preview: `node scripts/restore-drill.js D:\bestodine-backups\archives\bestodine-YYYYMMDDTHHMMSSZ.archive.gz --dry-run`
4. Run: `node scripts/restore-drill.js <archive>` (add `--drop` to rerun into an existing drill database).
5. Read the printed counts for `users`, `restaurants`, `orders`.
6. Compare with production (Atlas Data Explorer, or `node scripts/dbstats.js` against production if you use it): counts should match to within what changed since the backup time. Spot check: open a recent order in the restored DB and confirm its items and totals are intact.
7. Optional deeper check: start the backend against the restored scratch DB on another port with a throwaway `.env` (never the production one) and log in as a known user.
8. Delete the scratch database when done (drop `restore_drill_*`).
9. Fill in the log below.

### Drill checklist
- [ ] Newest archive is less than 36 hours old
- [ ] Archive restored without errors
- [ ] users count plausible
- [ ] restaurants count plausible
- [ ] orders count plausible and newest order date is close to the backup time
- [ ] One order spot-checked (items and totals intact)
- [ ] Time taken to restore recorded (this is your recovery time estimate)
- [ ] Scratch database dropped
- [ ] Off-site copy exists and is also restorable
- [ ] Encryption passphrase (if used) found in password manager

## 6. Drill log

| Date | Archive file | Restored by | users / restaurants / orders | Time taken | Result (pass/fail) and notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
|  |  |  |  |  |  |

---

## 7. What is NOT covered

- **Uploaded images and files on Cloudinary** (menu photos, logos): they are not in MongoDB, only their URLs are. Cloudinary does not back up for you by default; enable its backup option or export the media library periodically. Without that, a restored database has links to images that may be gone.
- **Environment secrets** (`.env`: JWT secrets, Cloudinary keys, payment keys, `MONGO_URL`): not in any dump. Keep them in a password manager or secrets vault, separate from the code. Losing the JWT secret logs everyone out; losing payment keys means regenerating them with the provider.
- **Atlas settings**: database users, IP access list, cluster tier and alerts are not in a dump or snapshot. Write them down.
- **Source code**: it is in git; push to the remote regularly.
- **Redis** (if used for sockets or cache): transient, not backed up; it is rebuilt.
- **Print agent, desktop and mobile app installs**: reinstallable, nothing stored there that matters.
- **Anything written after the last backup**: with daily dumps you can lose up to a day of orders. Path A with Continuous Cloud Backup is the only option here that reduces this to minutes.
- **Indexes**: mongodump records them and mongorestore recreates them, but a restore of a very large collection can take a while to rebuild indexes; include that in the timed drill.
