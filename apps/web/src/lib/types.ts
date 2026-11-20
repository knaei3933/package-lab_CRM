/** Result a server action reports back to the form that invoked it. */
export interface ActionState {
  ok: boolean;
  message: string;
  /** P0 R09: the Korean auxiliary sentence (shown to the representative only). */
  messageKo?: string | null | undefined;
  /**
   * P0: the refusal code the form reacts to — PROJECT_CONTEXT_MISMATCH offers
   * 「再読み込み」, SESSION_EXPIRED offers 「ログインする」, DUPLICATE offers the
   * link below.
   */
  code?: string | null | undefined;
  /** P0 R05: where the already-registered record is (「登録済みの記録を開く」). */
  link?: { href: string; label: string } | null | undefined;
  /** P0 R06: the id of the record this success wrote, so its row is highlighted after the refresh. */
  changedId?: string | null | undefined;
}

export interface Choice {
  value: string;
  label: string;
  /** G6: the stored EML's own Message-ID, when the server could extract one. */
  autoEvidenceIdentifier?: string | null;
  /** UI batch B: rendered inside <optgroup label={group}> after the ungrouped choices. */
  group?: string;
  /** P0 R02: the issuer of an approval-evidence document (customer_generated / seven / …). */
  issuerEntity?: string;
}
