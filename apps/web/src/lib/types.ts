/** Result a server action reports back to the form that invoked it. */
export interface ActionState {
  ok: boolean;
  message: string;
}

export interface Choice {
  value: string;
  label: string;
  /** G6: the stored EML's own Message-ID, when the server could extract one. */
  autoEvidenceIdentifier?: string | null;
}
