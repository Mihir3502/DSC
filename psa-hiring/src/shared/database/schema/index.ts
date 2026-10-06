// Explicit schema exports. Drizzle Kit reads this directory to generate
// migrations; business modules will add their own tables in later work items.
export { appSchema } from "./app";
export { systemMetadata } from "./system";
