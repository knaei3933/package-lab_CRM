import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const userRole = pgEnum('user_role', ['admin', 'staff', 'viewer']);
export const accountRole = pgEnum('account_role', ['end_customer', 'seven', 'maker']);
export const businessUnit = pgEnum('business_unit', ['F1']);
export const projectRoute = pgEnum('project_route', ['F1']);
export const projectStatus = pgEnum('project_status', ['DRAFT', 'ACTIVE', 'ARCHIVED']);

/**
 * M1 units vocabulary (design section 5). One shared enum keeps the vocabulary
 * in one place; per-table check constraints pin each table to a single domain
 * so film units (rolls/meters/sheets) and filling units (pods/pieces) can never
 * be mixed across the film/filling boundary.
 */
export const measureUnit = pgEnum('measure_unit', ['rolls', 'meters', 'sheets', 'pods', 'pieces']);

/**
 * M2 document intake vocabulary (design section 5.4). Seven document types cover
 * the F1 flow: the three input documents a PO is verified against, and the four
 * official artifacts whose registration requires a verified purchase order.
 */
export const documentType = pgEnum('document_type', [
  'seven_po',
  'filling_quote_seven',
  'film_quote_kanei',
  'proof',
  'approval_evidence',
  'send_evidence',
  'acceptance_evidence'
]);

/** Who the document claims to come from. Recorded, never inferred. */
export const issuerEntity = pgEnum('issuer_entity', ['seven', 'kanei', 'maker', 'customer_generated', 'unknown']);

/**
 * M3 dual-approval vocabulary (design section 5.7). The two organizations whose
 * approvals the artwork gate requires, the decisions they can record, and the
 * sources an approval evidence document may come from.
 */
export const approvalOrganization = pgEnum('approval_organization', ['customer', 'seven']);
export const approvalDecision = pgEnum('approval_decision', ['APPROVE', 'REVOKE']);
export const approvalEvidenceSource = pgEnum('approval_evidence_source', ['email', 'signed_document', 'other_verified']);

/**
 * Human verification result, kept separate from the content hash: a matching
 * hash only proves bytes are unchanged, never that a human confirmed the
 * document is authentic.
 */
export const verificationStatus = pgEnum('verification_status', ['unverified', 'verified', 'mismatch']);

export const filmSupplyOrderStatus = pgEnum('film_supply_order_status', [
  'DRAFT',
  'SEVEN_PO_VERIFIED',
  'ARTWORK_RECEIVED',
  'PROOF_READY',
  'APPROVAL_PENDING',
  'DUAL_APPROVED',
  'MAKER_PO_READY',
  'APPROVED_FOR_MANUAL_SEND',
  'MAKER_PO_SENT_MANUALLY',
  'MAKER_PO_ACCEPTED',
  'FILM_IN_PRODUCTION',
  'FILM_SHIPPED',
  'FILM_DELIVERED',
  'FILM_RECEIPT_ASSUMED_NO_ISSUE',
  'ON_HOLD',
  'CHANGE_REVIEW',
  'CANCELLATION_REVIEW'
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (table) => [check('users_role_valid', sql`${table.role} in ('admin', 'staff', 'viewer')`)]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true })
}, (table) => [
  index('sessions_user_id_idx').on(table.userId),
  index('sessions_expires_at_idx').on(table.expiresAt)
]);

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  role: accountRole('role').notNull(),
  externalCode: text('external_code').unique(),
  contactEmail: text('contact_email'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (table) => [
  unique('accounts_active_role_name_unique').on(table.name, table.role),
  index('accounts_role_idx').on(table.role)
]);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  businessUnit: businessUnit('business_unit').notNull(),
  route: projectRoute('route').notNull(),
  leadSource: text('lead_source').notNull(),
  status: projectStatus('status').notNull().default('DRAFT'),
  endCustomerAccountId: uuid('end_customer_account_id').notNull().references(() => accounts.id),
  sevenAccountId: uuid('seven_account_id').notNull().references(() => accounts.id),
  makerAccountId: uuid('maker_account_id').notNull().references(() => accounts.id),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (table) => [
  check('projects_f1_only', sql`${table.route} = 'F1' and ${table.businessUnit} = 'F1' and ${table.leadSource} = 'KANEI'`),
  check('projects_required_accounts_distinct', sql`${table.endCustomerAccountId} <> ${table.sevenAccountId} and ${table.endCustomerAccountId} <> ${table.makerAccountId} and ${table.sevenAccountId} <> ${table.makerAccountId}`),
  index('projects_business_route_idx').on(table.businessUnit, table.route),
  index('projects_created_by_idx').on(table.createdByUserId)
]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  requestMetadata: jsonb('request_metadata')
}, (table) => [
  index('audit_events_entity_idx').on(table.entityType, table.entityId),
  index('audit_events_actor_idx').on(table.actorUserId)
]);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions)
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] })
}));

export const projectsRelations = relations(projects, ({ one }) => ({
  endCustomerAccount: one(accounts, { fields: [projects.endCustomerAccountId], references: [accounts.id] }),
  sevenAccount: one(accounts, { fields: [projects.sevenAccountId], references: [accounts.id] }),
  makerAccount: one(accounts, { fields: [projects.makerAccountId], references: [accounts.id] }),
  createdBy: one(users, { fields: [projects.createdByUserId], references: [users.id] })
}));

export const projectAssignments = pgTable('project_assignments', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  unique('project_assignments_user_project_unique').on(table.userId, table.projectId),
  index('project_assignments_project_idx').on(table.projectId)
]);

/**
 * M1 transaction structure (design section 5).
 *
 * Date separation rule (design section 5.6): original_received_at is reference
 * data about a paper document arriving; official_registered_at is the moment
 * the seven purchase order became an official record. Every gate check reads
 * official_registered_at only — original_received_at must never satisfy a gate.
 *
 * M2: a document uploaded before a verified PO lands here, and the row is
 * append-only (migration 0005): original_received_at is immutable reference
 * data.
 */
export const preOrderReferences = pgTable('pre_order_references', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  referenceCode: text('reference_code').notNull().unique(),
  note: text('note'),
  originalReceivedAt: timestamp('original_received_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index('pre_order_references_project_idx').on(table.projectId)
]);

export const sevenPurchaseOrders = pgTable('seven_purchase_orders', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  poNumber: text('po_number').notNull().unique(),
  preOrderReferenceId: uuid('pre_order_reference_id').references(() => preOrderReferences.id),
  originalReceivedAt: timestamp('original_received_at', { withTimezone: true }),
  officialRegisteredAt: timestamp('official_registered_at', { withTimezone: true }),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  promotedByUserId: uuid('promoted_by_user_id').references(() => users.id),
  /**
   * M2 authenticity checklist result (design section 5.10). verificationStatus
   * is only ever written by the checklist submission endpoint from a human
   * record; it is never estimated from document metadata. A quote-vs-PO
   * mismatch stores reviewPending=true and keeps every precedence gate closed.
   */
  verificationStatus: verificationStatus('verification_status').notNull().default('unverified'),
  verifiedByUserId: uuid('verified_by_user_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationNote: text('verification_note'),
  authenticityChecklist: jsonb('authenticity_checklist'),
  reviewPending: boolean('review_pending').notNull().default(false),
  reviewNote: text('review_note'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  check('seven_purchase_orders_promotion_fields_pair', sql`(${table.promotedAt} is null) = (${table.promotedByUserId} is null)`),
  check('seven_purchase_orders_verification_fields_pair', sql`(${table.verificationStatus} = 'unverified' and ${table.verifiedAt} is null and ${table.verifiedByUserId} is null) or (${table.verificationStatus} in ('verified', 'mismatch') and ${table.verifiedAt} is not null and ${table.verifiedByUserId} is not null)`),
  check('seven_purchase_orders_review_pending_has_note', sql`${table.reviewPending} = false or ${table.reviewNote} is not null`),
  index('seven_purchase_orders_project_idx').on(table.projectId),
  index('seven_purchase_orders_verification_status_idx').on(table.verificationStatus)
]);

export const filmSupplyOrders = pgTable('film_supply_orders', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  code: text('code').notNull().unique(),
  status: filmSupplyOrderStatus('status').notNull().default('DRAFT'),
  sevenPurchaseOrderId: uuid('seven_purchase_order_id').references(() => sevenPurchaseOrders.id),
  holdReason: text('hold_reason'),
  exceptionNote: text('exception_note'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (table) => [
  index('film_supply_orders_project_idx').on(table.projectId),
  index('film_supply_orders_status_idx').on(table.status)
]);

/**
 * M2 document intake (design section 5.4). A documents row is the logical
 * document inside one project; its bytes live in append-only document_versions.
 * originalFilename is display metadata only — the storage path is generated by
 * the server and never derived from it.
 */
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  documentType: documentType('document_type').notNull(),
  issuerEntity: issuerEntity('issuer_entity').notNull(),
  originalFilename: text('original_filename').notNull(),
  note: text('note'),
  preOrderReferenceId: uuid('pre_order_reference_id').references(() => preOrderReferences.id),
  sevenPurchaseOrderId: uuid('seven_purchase_order_id').references(() => sevenPurchaseOrders.id),
  /**
   * M3 artwork binding: an optional record of which film supply order and
   * design a document belongs to. Approval evidence must carry this binding so
   * an approval can never cite paperwork of another order, design or company
   * (T-35). Null for documents uploaded outside the artwork flow.
   */
  filmSupplyOrderId: uuid('film_supply_order_id').references(() => filmSupplyOrders.id),
  designKey: text('design_key'),
  // Human verification of the document itself, deliberately separate from the
  // content hash recorded on document_versions.
  verificationStatus: verificationStatus('verification_status').notNull().default('unverified'),
  verifiedByUserId: uuid('verified_by_user_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationNote: text('verification_note'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  // One logical document per (project, type, issuer, filename): re-uploading the
  // same bytes lands on this row again instead of creating a duplicate.
  unique('documents_project_type_issuer_filename_unique').on(
    table.projectId,
    table.documentType,
    table.issuerEntity,
    table.originalFilename
  ),
  // Official artifacts are downstream of a purchase order; input documents
  // (the quotes and the PO itself) are not.
  check('documents_official_artifact_requires_po', sql`${table.documentType} in ('seven_po', 'filling_quote_seven', 'film_quote_kanei') or ${table.sevenPurchaseOrderId} is not null`),
  check('documents_verification_fields_pair', sql`(${table.verificationStatus} = 'unverified' and ${table.verifiedAt} is null and ${table.verifiedByUserId} is null) or (${table.verificationStatus} in ('verified', 'mismatch') and ${table.verifiedAt} is not null and ${table.verifiedByUserId} is not null)`),
  // The artwork binding is a pair: a document is bound to a design only through
  // an order, never to a design on its own.
  check('documents_artwork_binding_pair', sql`(${table.filmSupplyOrderId} is null and ${table.designKey} is null) or (${table.filmSupplyOrderId} is not null and ${table.designKey} is not null)`),
  index('documents_project_idx').on(table.projectId),
  index('documents_type_idx').on(table.documentType),
  index('documents_seven_purchase_order_idx').on(table.sevenPurchaseOrderId),
  index('documents_pre_order_reference_idx').on(table.preOrderReferenceId),
  index('documents_film_supply_order_idx').on(table.filmSupplyOrderId)
]);

/**
 * One row per distinct byte content uploaded to a document. sha256 is computed
 * by the server from the received bytes and never trusted from the client;
 * storagePath is a server-generated randomized path inside the private storage
 * folder. Rows are append-only (migration 0005): a recorded version is never
 * rewritten, and the same bytes re-uploaded to the same document resolve to the
 * existing row (T-27).
 */
export const documentVersions = pgTable('document_versions', {
  id: uuid('id').primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  sha256: text('sha256').notNull(),
  byteSize: integer('byte_size').notNull(),
  storagePath: text('storage_path').notNull(),
  originalFilename: text('original_filename').notNull(),
  declaredMimeType: text('declared_mime_type').notNull(),
  detectedMimeType: text('detected_mime_type'),
  sizeCheckPassed: boolean('size_check_passed').notNull(),
  typeCheckPassed: boolean('type_check_passed').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  unique('document_versions_document_version_unique').on(table.documentId, table.versionNumber),
  // Idempotency key for re-uploads within one document (T-27).
  unique('document_versions_document_sha256_unique').on(table.documentId, table.sha256),
  // Lookup for sharing one physical file across projects (T-26).
  index('document_versions_sha256_idx').on(table.sha256),
  index('document_versions_document_idx').on(table.documentId),
  check('document_versions_sha256_format', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check('document_versions_byte_size_positive', sql`${table.byteSize} > 0`),
  // Only uploads that passed both server-side checks are ever persisted.
  check('document_versions_checks_passed', sql`${table.sizeCheckPassed} = true and ${table.typeCheckPassed} = true`)
]);

/**
 * M3 proof revisions (design section 5.7). One row per registered revision of
 * one design of one film supply order. revision_no is unique per
 * (order, design_key) and never reused; the artwork file itself is an
 * append-only document_versions row, so a revision's bytes are immutable and
 * its sha256 is the revision hash every approval is bound to.
 */
export const artworkRevisions = pgTable('artwork_revisions', {
  id: uuid('id').primaryKey(),
  filmSupplyOrderId: uuid('film_supply_order_id').notNull().references(() => filmSupplyOrders.id, { onDelete: 'cascade' }),
  designKey: text('design_key').notNull(),
  revisionNo: integer('revision_no').notNull(),
  fileDocumentVersionId: uuid('file_document_version_id').notNull().references(() => documentVersions.id),
  lotMarking: text('lot_marking'),
  note: text('note'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  unique('artwork_revisions_order_design_revision_unique').on(table.filmSupplyOrderId, table.designKey, table.revisionNo),
  index('artwork_revisions_order_design_idx').on(table.filmSupplyOrderId, table.designKey),
  index('artwork_revisions_file_version_idx').on(table.fileDocumentVersionId),
  check('artwork_revisions_revision_no_positive', sql`${table.revisionNo} > 0`),
  check('artwork_revisions_design_key_not_blank', sql`length(btrim(${table.designKey})) > 0`)
]);

/**
 * M3 approval events (design section 5.7). Append-only (migration 0007): an
 * approval is an external fact recorded by an internal user — recorded_by is
 * always that internal recorder, never the external approver, whose identity is
 * only ever recorded as text. approved_file_sha256 is the exact revision hash
 * the decision was about, so a decision can never silently attach to different
 * bytes. Corrections and withdrawals are new REVOKE or superseding APPROVE
 * events; UPDATE and DELETE are rejected by trigger (T-12).
 */
export const artworkApprovalEvents = pgTable('artwork_approval_events', {
  id: uuid('id').primaryKey(),
  artworkRevisionId: uuid('artwork_revision_id').notNull().references(() => artworkRevisions.id),
  organization: approvalOrganization('organization').notNull(),
  decision: approvalDecision('decision').notNull(),
  externalApproverName: text('external_approver_name'),
  externalApproverOrg: text('external_approver_org'),
  recordedByUserId: uuid('recorded_by_user_id').notNull().references(() => users.id),
  evidenceDocumentVersionId: uuid('evidence_document_version_id').notNull().references(() => documentVersions.id),
  evidenceSource: approvalEvidenceSource('evidence_source').notNull(),
  approvedFileSha256: text('approved_file_sha256').notNull(),
  /** When the external organization actually decided; recorded_at is when we wrote it down. */
  eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  supersedesEventId: uuid('supersedes_event_id').references((): AnyPgColumn => artworkApprovalEvents.id)
}, (table) => [
  check('artwork_approval_events_sha256_format', sql`${table.approvedFileSha256} ~ '^[0-9a-f]{64}$'`),
  index('artwork_approval_events_revision_idx').on(table.artworkRevisionId),
  index('artwork_approval_events_organization_idx').on(table.organization),
  index('artwork_approval_events_supersedes_idx').on(table.supersedesEventId)
]);

export const filmSupplyOrderLines = pgTable('film_supply_order_lines', {
  id: uuid('id').primaryKey(),
  filmSupplyOrderId: uuid('film_supply_order_id').notNull().references(() => filmSupplyOrders.id, { onDelete: 'cascade' }),
  lineNumber: integer('line_number').notNull(),
  description: text('description').notNull(),
  orderedQuantity: numeric('ordered_quantity', { precision: 14, scale: 3 }).notNull(),
  unit: measureUnit('unit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  unique('film_supply_order_lines_order_line_unique').on(table.filmSupplyOrderId, table.lineNumber),
  // FK target for deliveries: pins a delivery to (order, line, unit) in one constraint.
  unique('film_supply_order_lines_order_line_unit_unique').on(table.filmSupplyOrderId, table.id, table.unit),
  check('film_supply_order_lines_unit_is_film', sql`${table.unit} in ('rolls', 'meters', 'sheets')`),
  check('film_supply_order_lines_quantity_positive', sql`${table.orderedQuantity} > 0`),
  index('film_supply_order_lines_order_idx').on(table.filmSupplyOrderId)
]);

export const filmDeliveries = pgTable('film_deliveries', {
  id: uuid('id').primaryKey(),
  filmSupplyOrderId: uuid('film_supply_order_id').notNull(),
  filmSupplyOrderLineId: uuid('film_supply_order_line_id').notNull(),
  unit: measureUnit('unit').notNull(),
  deliveredQuantity: numeric('delivered_quantity', { precision: 14, scale: 3 }).notNull(),
  deliverySequence: integer('delivery_sequence').notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
  carrierReference: text('carrier_reference'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  // (order, line, unit) must match the referenced line exactly, so a delivery can
  // never disagree with its line about order or unit.
  foreignKey({
    name: 'film_deliveries_line_fk',
    columns: [table.filmSupplyOrderId, table.filmSupplyOrderLineId, table.unit],
    foreignColumns: [filmSupplyOrderLines.filmSupplyOrderId, filmSupplyOrderLines.id, filmSupplyOrderLines.unit]
  }),
  unique('film_deliveries_line_sequence_unique').on(table.filmSupplyOrderLineId, table.deliverySequence),
  check('film_deliveries_unit_is_film', sql`${table.unit} in ('rolls', 'meters', 'sheets')`),
  check('film_deliveries_quantity_positive', sql`${table.deliveredQuantity} > 0`),
  index('film_deliveries_order_idx').on(table.filmSupplyOrderId),
  index('film_deliveries_line_idx').on(table.filmSupplyOrderLineId)
]);

export const fillingOrders = pgTable('filling_orders', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  code: text('code').notNull().unique(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (table) => [
  index('filling_orders_project_idx').on(table.projectId)
]);

export const fillingOrderLines = pgTable('filling_order_lines', {
  id: uuid('id').primaryKey(),
  fillingOrderId: uuid('filling_order_id').notNull().references(() => fillingOrders.id, { onDelete: 'cascade' }),
  lineNumber: integer('line_number').notNull(),
  description: text('description').notNull(),
  orderedQuantity: numeric('ordered_quantity', { precision: 14, scale: 3 }).notNull(),
  unit: measureUnit('unit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  unique('filling_order_lines_order_line_unique').on(table.fillingOrderId, table.lineNumber),
  unique('filling_order_lines_order_line_unit_unique').on(table.fillingOrderId, table.id, table.unit),
  check('filling_order_lines_unit_is_filling', sql`${table.unit} in ('pods', 'pieces')`),
  check('filling_order_lines_quantity_positive', sql`${table.orderedQuantity} > 0`),
  index('filling_order_lines_order_idx').on(table.fillingOrderId)
]);

export const fillingDeliveries = pgTable('filling_deliveries', {
  id: uuid('id').primaryKey(),
  fillingOrderId: uuid('filling_order_id').notNull(),
  fillingOrderLineId: uuid('filling_order_line_id').notNull(),
  unit: measureUnit('unit').notNull(),
  deliveredQuantity: numeric('delivered_quantity', { precision: 14, scale: 3 }).notNull(),
  deliverySequence: integer('delivery_sequence').notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
  carrierReference: text('carrier_reference'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  foreignKey({
    name: 'filling_deliveries_line_fk',
    columns: [table.fillingOrderId, table.fillingOrderLineId, table.unit],
    foreignColumns: [fillingOrderLines.fillingOrderId, fillingOrderLines.id, fillingOrderLines.unit]
  }),
  unique('filling_deliveries_line_sequence_unique').on(table.fillingOrderLineId, table.deliverySequence),
  check('filling_deliveries_unit_is_filling', sql`${table.unit} in ('pods', 'pieces')`),
  check('filling_deliveries_quantity_positive', sql`${table.deliveredQuantity} > 0`),
  index('filling_deliveries_order_idx').on(table.fillingOrderId),
  index('filling_deliveries_line_idx').on(table.fillingOrderLineId)
]);

/**
 * Commission readiness is written only by the explicit evaluate endpoint, never
 * as a side effect of a delivery: recording a film delivery must not create any
 * filling delivery or commission row (T-14).
 */
export const commissionReadiness = pgTable('commission_readiness', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().unique().references(() => projects.id),
  filmDeliveryRecorded: boolean('film_delivery_recorded').notNull().default(false),
  fillingDeliveryRecorded: boolean('filling_delivery_recorded').notNull().default(false),
  sevenPoOfficiallyRegistered: boolean('seven_po_officially_registered').notNull().default(false),
  isReady: boolean('is_ready').notNull().default(false),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
  evaluatedByUserId: uuid('evaluated_by_user_id').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  check('commission_readiness_ready_requires_ready_at', sql`(${table.isReady} = false) or (${table.readyAt} is not null)`)
]);

export const filmSupplyOrdersRelations = relations(filmSupplyOrders, ({ many, one }) => ({
  lines: many(filmSupplyOrderLines),
  deliveries: many(filmDeliveries),
  project: one(projects, { fields: [filmSupplyOrders.projectId], references: [projects.id] }),
  sevenPurchaseOrder: one(sevenPurchaseOrders, { fields: [filmSupplyOrders.sevenPurchaseOrderId], references: [sevenPurchaseOrders.id] })
}));

export const documentsRelations = relations(documents, ({ many, one }) => ({
  versions: many(documentVersions),
  project: one(projects, { fields: [documents.projectId], references: [projects.id] }),
  preOrderReference: one(preOrderReferences, { fields: [documents.preOrderReferenceId], references: [preOrderReferences.id] }),
  sevenPurchaseOrder: one(sevenPurchaseOrders, { fields: [documents.sevenPurchaseOrderId], references: [sevenPurchaseOrders.id] })
}));

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, { fields: [documentVersions.documentId], references: [documents.id] })
}));

export const artworkRevisionsRelations = relations(artworkRevisions, ({ many, one }) => ({
  approvalEvents: many(artworkApprovalEvents),
  filmSupplyOrder: one(filmSupplyOrders, { fields: [artworkRevisions.filmSupplyOrderId], references: [filmSupplyOrders.id] }),
  fileDocumentVersion: one(documentVersions, { fields: [artworkRevisions.fileDocumentVersionId], references: [documentVersions.id] })
}));

export const artworkApprovalEventsRelations = relations(artworkApprovalEvents, ({ one }) => ({
  revision: one(artworkRevisions, { fields: [artworkApprovalEvents.artworkRevisionId], references: [artworkRevisions.id] }),
  evidenceDocumentVersion: one(documentVersions, { fields: [artworkApprovalEvents.evidenceDocumentVersionId], references: [documentVersions.id] }),
  recordedBy: one(users, { fields: [artworkApprovalEvents.recordedByUserId], references: [users.id] })
}));

export const fillingOrdersRelations = relations(fillingOrders, ({ many, one }) => ({
  lines: many(fillingOrderLines),
  deliveries: many(fillingDeliveries),
  project: one(projects, { fields: [fillingOrders.projectId], references: [projects.id] })
}));
