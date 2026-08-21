// AI-HQ environment check.
//
// Confirms this computer can run the project. Uses no external
// packages on purpose, so it works before "npm install".
//
// Run it with:  npm run check

import { existsSync } from "node:fs";

const REQUIRED_MAJOR = 20;

let failures = 0;

function pass(msg) {
  console.log(`  OK    ${msg}`);
}

function fail(msg, fix) {
  console.log(`  FAIL  ${msg}`);
  console.log(`        → ${fix}`);
  failures++;
}

function warn(msg, fix) {
  console.log(`  WARN  ${msg}`);
  console.log(`        → ${fix}`);
}

console.log("\nAI-HQ environment check\n");

const major = Number(process.versions.node.split(".")[0]);
if (major >= REQUIRED_MAJOR) {
  pass(`Node.js ${process.versions.node}`);
} else {
  fail(
    `Node.js ${process.versions.node} is too old (need ${REQUIRED_MAJOR} or newer)`,
    "Install the current LTS version from https://nodejs.org",
  );
}

if (existsSync(".env")) {
  pass(".env file found");
} else {
  warn(
    "No .env file yet",
    'Copy the example file:  cp .env.example .env   (works on Windows PowerShell too)',
  );
}

console.log(
  failures === 0
    ? "\nReady.\n"
    : `\n${failures} problem(s) found. Fix the lines marked FAIL above.\n`,
);

process.exit(failures === 0 ? 0 : 1);
