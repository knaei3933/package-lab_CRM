import { CheckboxField } from './fields';
import { approvalCardFacts } from '../lib/approval-snapshot';

/**
 * Review H1: the maker PO list's 代表承認 carries the snapshot hash of the paper AS THIS SCREEN
 * WAS DRAWN (read from the approval card at render time) — never one read again at submit, so
 * a line added after the screen was drawn is refused by the API (409), not approved unseen.
 * Without a readable hash the form says so and the action refuses to send.
 */
export async function ApprovalSnapshotFields({ poId }: { poId: string }) {
  const facts = await approvalCardFacts(poId);
  return (
    <>
      <input type="hidden" readOnly name="expectedSnapshotSha256" value={facts.hash ?? ''} />
      {facts.amountMissing ? (
        <>
          <input type="hidden" readOnly name="amountMissing" value="true" />
          <CheckboxField name="acknowledgeMissingAmount" label="金額未入力のまま承認する" required />
        </>
      ) : null}
    </>
  );
}
