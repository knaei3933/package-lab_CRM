import { boolean, check, index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const userRole = pgEnum('user_role', ['admin', 'staff', 'viewer']);
export const accountRole = pgEnum('account_role', ['end_customer', 'seven', 'maker']);
export const businessUnit = pgEnum('business_unit', ['F1']);
export const projectRoute = pgEnum('project_route', ['F1']);
export const projectStatus = pgEnum('project_status', ['DRAFT', 'ACTIVE', 'ARCHIVED']);

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
