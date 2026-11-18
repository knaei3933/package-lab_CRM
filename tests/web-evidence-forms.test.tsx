import { renderToString } from 'react-dom/server';
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import type { FormAction } from '../apps/web/src/components/ActionForm';
import { ApprovalDecisionForm } from '../apps/web/src/components/ApprovalDecisionForm';
import { MakerPoSendEvidenceForm } from '../apps/web/src/components/MakerPoSendEvidenceForm';
import type { ActionState } from '../apps/web/src/lib/types';

const action: FormAction = async (): Promise<ActionState> => ({ ok: true, message: '記録しました。' });

describe('evidence form accessibility and G3 subject action', () => {
  it('renders the G3 subject with a token-boundary order code and the submitted EML field', () => {
    const html = renderToString(
      <MakerPoSendEvidenceForm
        action={action}
        poId="po-1"
        sendEvidenceChoices={[]}
        recipientAddress="maker@example.test"
        ceoApprovedAt="2026-11-17T09:00:00+09:00"
        orderCode="FSO-1"
      />
    );
    expect(html).toContain('FSO-1 製造先発注書');
    expect(html).toContain('name="contentBase64"');
    expect(html).toContain('先頭の発注コードは自動挿入されます');
  });

  it('links one shared G6 guidance to both the version select and identifier input', () => {
    const html = renderToString(
      <ApprovalDecisionForm
        action={action}
        revisionId="revision-1"
        designKey="label-front"
        evidenceChoices={[{
          value: 'version-1',
          label: 'approval.eml（版2）',
          autoEvidenceIdentifier: '<approval@example.test>'
        }]}
        evidenceSourceChoices={[{ value: 'email', label: 'メール' }]}
        defaultEventTime="2026-11-17T18:00"
      />
    );
    const helpCount = html.match(/Message-IDはシステムが自動抽出します/g)?.length ?? 0;
    expect(helpCount).toBe(1);
    expect(html.match(/<(?:select|input|textarea)\b[^>]*aria-describedby=/g)?.length).toBe(2);
    expect(html).toContain('value="&lt;approval@example.test&gt;"');
  });
});
