import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveLocalDocumentRoot } from "./lib/local-paths";

// Creates the private local document directory. Never deletes or empties
// anything, never copies .env.example, and never creates sample documents.

const projectRoot = path.resolve(import.meta.dirname, "..");
const configured = process.env.DOCUMENT_STORAGE_ROOT;

if (!configured) {
  console.error(
    "DOCUMENT_STORAGE_ROOT is not set. Create .env.local from .env.example first.",
  );
  process.exit(1);
}

let target: string;
try {
  target = resolveLocalDocumentRoot(configured, projectRoot);
} catch (error) {
  console.error(
    `Refusing to set up local storage: ${(error as Error).message}`,
  );
  process.exit(1);
}

const display = path.relative(projectRoot, target);

if (existsSync(target)) {
  if (!statSync(target).isDirectory()) {
    console.error(
      `Refusing to set up local storage: ${display} is not a directory`,
    );
    process.exit(1);
  }
  console.log(
    `Local document directory already exists: ${display} (unchanged)`,
  );
} else {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  console.log(`Created private local document directory: ${display}`);
}
