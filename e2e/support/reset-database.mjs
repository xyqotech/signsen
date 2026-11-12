// Gives the end-to-end run an empty database: drops and recreates the one named
// in DATABASE_URL, through the server connection of TEST_DATABASE_URL.
// Run by the Playwright web server command, before the application starts.
import pg from "pg";

const E2E_PREFIX = "signsen_e2e";

const serverUrl = process.env.TEST_DATABASE_URL;
const targetUrl = process.env.DATABASE_URL;
if (!serverUrl || !targetUrl) {
  console.error("reset-database: TEST_DATABASE_URL and DATABASE_URL are both required.");
  process.exit(1);
}

const name = decodeURIComponent(new URL(targetUrl).pathname.slice(1));
// This script destroys a database: it only ever touches one made for these tests.
if (!name.startsWith(E2E_PREFIX) || !/^[a-z0-9_]+$/.test(name)) {
  console.error(`reset-database: refusing to drop "${name}" — the name must start with "${E2E_PREFIX}".`);
  process.exit(1);
}

const admin = new pg.Client({ connectionString: serverUrl });
try {
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  console.log(`reset-database: "${name}" is empty and ready.`);
} catch (e) {
  console.error(`reset-database: cannot prepare "${name}" on the server of TEST_DATABASE_URL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await admin.end().catch(() => {});
}
