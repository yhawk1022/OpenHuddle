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
  type ManagedPgliteSocketServer,
  type PgliteSocketServerOptions,
  startPgliteSocketServer,
} from "./pglite-server.js";
export {
  adminAuditLogsTable,
  agentsTable,
  authOtpCodesTable,
  friendshipsTable,
  messagesTable,
  pairingCodesTable,
  proposalsTable,
  proposalVotesTable,
  roomMembersTable,
  roomsTable,
  userSessionsTable,
  usersTable,
} from "./schema.js";
