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
  DEFAULT_PGLITE_SNAPSHOT_KEEP,
  findLatestPgliteSnapshot,
  pruneArchivedDirectories,
  restorePgliteSnapshot,
  writePgliteSnapshot,
} from "./pglite-backup.js";
export {
  isCorruptedLocalPgliteError,
  type PgliteSalvageReport,
  salvageCorruptedPgliteInto,
} from "./pglite-salvage.js";
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
  messageAttachmentsTable,
  messagesTable,
  pairingCodesTable,
  proposalsTable,
  proposalVotesTable,
  roomMembersTable,
  roomsTable,
  userSessionsTable,
  usersTable,
  workItemsTable,
  workSlicesTable,
  workspaceRoomBindingsTable,
  workspacesTable,
} from "./schema.js";
