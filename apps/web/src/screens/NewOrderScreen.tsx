import Link from 'next/link';
import { NewOrderForm } from '../components/NewOrderForm';
import { startFilmOrderAction } from '../app/step-actions';
import { loadSessionUser } from '../lib/api';
import { PAYMENT_TERMS_LABELS } from '../lib/maker-po-data';
import { canRoleOperate } from '../lib/permissions';
import { loadWorkspace, sevenPurchaseOrderChoiceLabel } from '../lib/project-data';
import { projectPath } from '../lib/project-route';
import { unitChoices } from '../lib/vocabulary';
import type { ProjectScreenProps } from './screen-props';

/** P1 R21: /p/{案件}/new — the new film order (steps 1–3 on one form, one submit). */
export async function NewOrderScreen({ projectId, projectCode }: ProjectScreenProps) {
  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  if (!user) return null;
  const canCreate = canRoleOperate(user.role, 'film_order:create');
  // A registered PO can take a new order; one not yet checked is checked here first
  // (also the way back after a submit stopped at 照合 — the PO is not created twice).
  const existing = workspace.sevenPurchaseOrders
    .filter((po) => po.officiallyRegistered)
    .map((po) => ({
      value: po.id,
      label: `${sevenPurchaseOrderChoiceLabel(po)}${po.verificationStatus === 'verified' ? '' : '（照合がまだ）'}`
    }));
  const unverifiedIds = workspace.sevenPurchaseOrders
    .filter((po) => po.officiallyRegistered && po.verificationStatus !== 'verified')
    .map((po) => po.id);
  return (
    <section className="p1-new" aria-labelledby="new-order-title">
      <nav className="p1-crumbs" aria-label="現在の位置">
        <ol>
          <li><Link href={projectPath(projectCode)} translate="no">{projectCode}</Link></li>
          <li aria-current="page">新しいフィルム発注</li>
        </ol>
      </nav>
      <h1 id="new-order-title" className="p1-title">新しいフィルム発注</h1>
      <p className="p1-lead">セブン化学発注書の受付から発注内容まで、この1画面で記録します。記録すると発注の画面が開きます。</p>
      {workspace.error ? <p className="p1-banner p1-banner--error" role="alert">{workspace.error}</p> : null}
      {canCreate ? (
        <NewOrderForm
          action={startFilmOrderAction}
          projectCode={projectCode}
          unitChoices={unitChoices('film')}
          paymentTermsChoices={[
            { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
            { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
            { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
          ]}
          existingPoChoices={existing}
          unverifiedPoIds={unverifiedIds}
        />
      ) : (
        <p className="p1-waiting">この役割では発注を作成できません（閲覧のみ）。</p>
      )}
    </section>
  );
}
