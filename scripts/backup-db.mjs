import { exec } from "child_process";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const BACKUP_PATH = process.env.BACKUP_PATH || "./backups";

if (!MONGO_URI) {
  console.error("❌ MONGO_URI is not defined in environment variables.");
  process.exit(1);
}

if (!fs.existsSync(BACKUP_PATH)) {
  fs.mkdirSync(BACKUP_PATH, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const archiveName = `backup-${timestamp}.gz`;
const outputPath = path.join(BACKUP_PATH, archiveName);

console.log(`🚀 Starting backup to ${outputPath}...`);

const command = `mongodump --uri="${MONGO_URI}" --archive="${outputPath}" --gzip`;

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error(`❌ Backup failed: ${error.message}`);
    return;
  }
  if (stderr && !stderr.includes("done dumping")) {
    console.warn(`⚠️  mongodump stderr: ${stderr}`);
  }
  console.log(`✅ Backup completed successfully: ${archiveName}`);
  
  // Optional: Add logic here to push the archive to external storage (S3, Cloud Storage, etc.)
});
