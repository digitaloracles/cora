import { rotateBackups } from "./storage-backups.js";

try {
  console.log(JSON.stringify(rotateBackups(JSON.parse(process.argv[2]))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
