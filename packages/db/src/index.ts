/**
 * @module db
 * @description `@openhuddle/db` 统一公共导出入口。
 */
export { ensureCoreSchema } from "./bootstrap.js";
export {
  createDatabaseClient,
  type DatabaseClientOptions,
  type ManagedDatabase,
  type OpenHuddleDb,
} from "./client.js";
export {
  agentsTable,
  messagesTable,
  pairingCodesTable,
  proposalsTable,
  proposalVotesTable,
  roomMembersTable,
  roomsTable,
  usersTable,
} from "./schema.js";
