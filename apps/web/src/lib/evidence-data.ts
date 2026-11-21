import { callApi } from './api';
import { DOCUMENT_TYPE_LABELS, ISSUER_ENTITY_LABELS } from './vocabulary';
import type { DocumentType, IssuerEntity } from '@kanei/core';

/**
 * P2 P-2 (contract §7): the evidence metadata of a project — what was filed,
 * by whom and when, with the file's SHA-256. Never the bytes, a storage path,
 * a note or an amount; for an auditor the API also withholds the filename of a
 * quote or a PO (originalFilenameHidden). This module only reads and shapes it.
 */
export interface EvidenceVersionView {
  versionId: string;
  versionNumber: number | null;
  originalFilename: string | null;
  sha256: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
}

export interface EvidenceDocumentView {
  documentId: string;
  documentType: string;
  issuerEntity: string;
  originalFilename: string | null;
  filenameHidden: boolean;
  orderCode: string | null;
  designKey: string | null;
  verificationStatus: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  createdAt: string | null;
  createdBy: string | null;
  versions: EvidenceVersionView[];
}

export interface EvidenceMetadata {
  documents: EvidenceDocumentView[];
  truncated: boolean;
  limit: number | null;
}

export type EvidenceRead = { ok: true; data: EvidenceMetadata } | { ok: false; status: number; error: string };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function person(value: unknown): string | null {
  return str(record(value).displayName);
}

/** Pure: GET …/evidence-metadata in the screen's shape (only the keys the screen shows are kept). */
export function parseEvidenceMetadata(data: unknown): EvidenceMetadata | null {
  const body = record(data);
  if (!Array.isArray(body.documents)) return null;
  const documents = body.documents.map((item): EvidenceDocumentView => {
    const doc = record(item);
    const filename = str(doc.originalFilename);
    const versions = (Array.isArray(doc.versions) ? doc.versions : []).map((entry): EvidenceVersionView => {
      const version = record(entry);
      return {
        versionId: str(version.versionId) ?? '',
        versionNumber: typeof version.versionNumber === 'number' ? version.versionNumber : null,
        originalFilename: str(version.originalFilename),
        sha256: str(version.sha256),
        uploadedAt: str(version.uploadedAt),
        uploadedBy: person(version.uploadedBy)
      };
    });
    return {
      documentId: str(doc.documentId) ?? '',
      documentType: str(doc.documentType) ?? '',
      issuerEntity: str(doc.issuerEntity) ?? '',
      originalFilename: filename,
      filenameHidden: doc.originalFilenameHidden === true || filename === null,
      orderCode: str(doc.orderCode),
      designKey: str(doc.designKey),
      verificationStatus: str(doc.verificationStatus),
      verifiedAt: str(doc.verifiedAt),
      verifiedBy: person(doc.verifiedBy),
      createdAt: str(doc.createdAt),
      createdBy: person(doc.createdBy),
      versions
    };
  });
  return { documents, truncated: body.truncated === true, limit: typeof body.limit === 'number' ? body.limit : null };
}

/** The request path: the project, an optional order filter and the row limit. */
export function evidencePath(projectId: string, options: { filmSupplyOrderId?: string | null; limit?: number } = {}): string {
  const query = new URLSearchParams();
  if (options.filmSupplyOrderId) query.set('filmSupplyOrderId', options.filmSupplyOrderId);
  if (options.limit) query.set('limit', String(options.limit));
  const suffix = query.toString();
  return `/api/projects/${encodeURIComponent(projectId)}/evidence-metadata${suffix ? `?${suffix}` : ''}`;
}

export async function loadEvidenceMetadata(
  projectId: string,
  options: { filmSupplyOrderId?: string | null; limit?: number } = {}
): Promise<EvidenceRead> {
  const result = await callApi<unknown>(evidencePath(projectId, options));
  if (!result.ok) return { ok: false, status: result.status, error: result.error ?? '証跡の一覧を読み込めませんでした。' };
  const parsed = parseEvidenceMetadata(result.data);
  return parsed ? { ok: true, data: parsed } : { ok: false, status: result.status, error: '応答の形式が想定と違います。' };
}

export function documentTypeText(type: string): string {
  return DOCUMENT_TYPE_LABELS[type as DocumentType] ?? '書類';
}

export function issuerText(issuer: string): string {
  return ISSUER_ENTITY_LABELS[issuer as IssuerEntity] ?? '発行元不明';
}

/** 「ab12…ef90」: the first and last four characters of the SHA-256. */
export function shortHash(sha256: string | null): string | null {
  return sha256 && sha256.length >= 8 ? `${sha256.slice(0, 4)}…${sha256.slice(-4)}` : null;
}
