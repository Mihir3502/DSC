// Public technical surface of the database layer. Server-only: client
// components must never import this module.
export { closeDatabasePool, getDatabase, type Database } from "./client";
export { systemMetadata } from "./schema";
