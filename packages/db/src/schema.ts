import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
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
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  check('seven_purchase_orders_promotion_fields_pair', sql`(${table.promotedAt} is null) = (${table.promotedByUserId} is null)`),
  index('seven_purchase_orders_project_idx').on(table.projectId)
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

export const fillingOrdersRelations = relations(fillingOrders, ({ many, one }) => ({
  lines: many(fillingOrderLines),
  deliveries: many(fillingDeliveries),
  project: one(projects, { fields: [fillingOrders.projectId], references: [projects.id] })
}));
