import { PROGRESS_STEPS } from './project-data';
import type { ScreenPath } from './project-data';

/**
 * UI nav-dashboard (C): the content of /guide — the first read for a new
 * operator. Grounded in Workflow v1.3 §4 A-2 / §5 F1 (film order flow) and
 * the persona tasks (demo-eml/ui-personas). Korean guide sentences keep the
 * screen, button and state names in the Japanese the screens show.
 */

export interface GuideStep {
  /** Same name as the step on every screen's stepper (PROGRESS_STEPS). */
  name: (typeof PROGRESS_STEPS)[number];
  what: string;
  who: string;
  screens: ScreenPath[];
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    name: '発注書確認',
    what: 'セブン化学의 PDF 発注書를 등록하고 公式登録日과 真性行チェックリスト를 기록합니다. 그 発注書를 골라 フィルム発注（コード・決済条件・明細）을 만들고 「セブン確認済み」로 진행합니다.',
    who: '担当者',
    screens: ['/orders']
  },
  {
    name: 'デザイン受領',
    what: '発注書 접수 뒤에 받은 デザイン入稿データ（ロット表示 포함）를 文書 화면에 올리고, 発注을 「デザイン受領」으로 진행합니다.',
    who: '担当者',
    screens: ['/documents', '/orders']
  },
  {
    name: '校正・校了',
    what: 'メーカー 디자이너의 校正ゲラ를 올리고 承認 화면에서 版을 등록합니다. 같은 版에 顧客 承認과 セブン化学 承認을 각각 기록하면（순서 무관）자동으로 「校了（ダブル承認）」이 됩니다.',
    who: '担当者',
    screens: ['/documents', '/approvals']
  },
  {
    name: '発注書・代表承認',
    what: '発注을 「製造先発注準備完了」로 진행하면 代表者가 メーカー発注書를 작성하고 代表承認을 기록합니다. 決済条件（G6）이 확정되어 있어야 승인할 수 있습니다.',
    who: '代表者',
    screens: ['/orders', '/maker-po']
  },
  {
    name: 'メーカーへ送信',
    what: '메일 프로그램에서 メーカー에 실제로 발송한 뒤, 보낸 메일의 원본（.eml）으로 手動送信을 기록합니다. CRM이 메일을 보내지는 않습니다.',
    who: '担当者',
    screens: ['/maker-po']
  },
  {
    name: '受入確認',
    what: '担当者가 受入（仮）과 受領証跡을 기록하고, 代表者가 証跡을 확인해 最終受入을 기록합니다.',
    who: '担当者 → 代表者',
    screens: ['/maker-po', '/documents']
  },
  {
    name: '生産・出荷',
    what: 'メーカー의 생산이 시작되면 「生産中」, 출하되면 「発送済み」로 発注 상태를 진행합니다.',
    who: '担当者',
    screens: ['/orders']
  },
  {
    name: '納品・受領',
    what: '納品（수량・날짜）을 기록하고, 受領確認（問題なしとみなす）을 기록하거나 受領証跡을 인용해 納品確認을 합니다. 마지막으로 手数料準備状態를 다시 평가합니다.',
    who: '担当者',
    screens: ['/deliveries', '/orders']
  }
];

export interface GuideDay {
  role: 'admin' | 'staff' | 'viewer';
  title: string;
  steps: readonly string[];
}

export const GUIDE_DAYS: readonly GuideDay[] = [
  {
    role: 'admin',
    title: '代表者（admin）의 하루',
    steps: [
      '로그인하면 ダッシュボード가 열립니다. 「지금 내가 할 일」과 「代表者の対応待ち（ほかの案件）」를 봅니다.',
      'メーカー発注書 작성・代表承認: 확인 대화상자의 金額・宛先・決済条件을 보고 승인합니다.',
      '送信未確認・承認証跡의 手動確認이 있으면 원본 EML과 내용을 비교해 기록합니다.',
      '受入（仮）이 기록된 発注은 受領証跡을 확인하고 最終受入을 기록합니다.',
      '保留・取消レビュー 중인 発注은 이유를 읽고 解除・処理합니다（理由 입력 필수）.'
    ]
  },
  {
    role: 'staff',
    title: '担当者（staff）의 하루',
    steps: [
      '로그인 → ダッシュボード에서 담당 案件을 확인합니다（위의 「案件」에서 전환）.',
      '「지금 내가 할 일」을 위에서부터 처리합니다. 항목을 누르면 그 작업 화면의 해당 発注으로 이동합니다.',
      '새 セブン化学発注書가 오면 案件（発注）画面에서 등록 → 公式登録 → 真性行チェックリスト → フィルム発注 작성.',
      '파일（デザイン・校正ゲラ・承認証跡・受領証跡）은 文書 화면에 올리고, 承認은 承認 화면에서 기록합니다.',
      '代表者만 할 수 있는 작업（代表承認・最終受入・保留解除）은 「代表者 대기」에 나옵니다. 필요하면 代表者에게 요청합니다.'
    ]
  },
  {
    role: 'viewer',
    title: '閲覧者（viewer）의 하루',
    steps: [
      'ダッシュボード에서 段階ごとの件数와 「막힌 건」을 봅니다.',
      '案件（発注）・メーカー発注・納品確認 화면에서 진행 상황을 확인합니다. 기록・변경은 할 수 없습니다.',
      '「（閲覧権限なし）」는 기록이 없다는 뜻이 아니라, 이 역할에는 보여 주지 않는 값이라는 뜻입니다.'
    ]
  }
];

export interface GuideTerm {
  term: string;
  meaning: string;
}

export const GUIDE_TERMS: readonly GuideTerm[] = [
  { term: '案件', meaning: '고객・제품 단위의 업무 묶음. 화면 위 「案件」에서 고르면 모든 화면이 그 案件을 보여 줍니다.' },
  { term: 'セブン化学発注書', meaning: 'セブン化学이 KANEI에 보내는 필름 정식 PDF 発注書. 이것이 디자인 입고보다 먼저입니다.' },
  { term: '公式登録日・真性行チェックリスト', meaning: '発注書가 정식으로 등록된 날짜와, 発注書 내용（번호・수량・견적 일치）을 확인한 기록.' },
  { term: 'フィルム発注', meaning: '하나의 필름 주문. 상태（下書き → … → 受領確認済）가 업무 순서대로 진행됩니다.' },
  { term: '決済条件（G6）', meaning: '前払い・搬入時払い・未確定. 모든 역할에 공개됩니다. 未確定이면 代表承認을 기록할 수 없습니다.' },
  { term: '校正ゲラ・版', meaning: 'メーカー 디자이너가 만든 교정본과 그 번호. 수정하면 새 版이 되고, 승인을 다시 받아야 합니다.' },
  { term: '校了（ダブル承認）', meaning: '같은 版에 대해 顧客과 セブン化学 둘 다 승인한 상태. 한쪽만으로는 メーカー 발주를 할 수 없습니다.' },
  { term: 'メーカー発注書・代表承認', meaning: '한국 メーカー에 보내는 생산 発注書. セブン化学発注書와는 별개 문서이며, 代表者의 승인이 있어야 보낼 수 있습니다.' },
  { term: '手動送信（EML）', meaning: '사람이 메일로 보낸 사실을, 보낸 메일 원본（.eml）으로 기록하는 것. CRM은 메일을 보내지 않습니다.' },
  { term: '受入（仮）・最終受入', meaning: 'メーカー가 発注을 받았다는 기록. 担当者의 임시 기록 뒤 代表者가 証跡을 보고 최종 확인합니다.' },
  { term: '受領確認・納品確認', meaning: '納品을 문제없이 받았다는 기록. 受領証跡을 인용하면 手数料準備에 쓰입니다.' },
  { term: '手数料準備状態', meaning: '수수료 계산에 필요한 納品・証跡이 다 모였는지의 평가. 금액・수수료 자체는 代表者만 봅니다.' },
  { term: '保留・変更レビュー・取消レビュー', meaning: '発注이 멈춘 상태. 保留 해제와 取消レビュー 처리는 代表者만, 変更レビュー는 再開할 상태를 골라 진행합니다.' },
  { term: '（閲覧権限なし）', meaning: '기록은 있지만 이 역할에는 보여 주지 않는 값. 「未記録」（기록 없음）과는 다릅니다.' }
];

export interface GuideTrouble {
  question: string;
  answer: string;
}

export const GUIDE_TROUBLES: readonly GuideTrouble[] = [
  {
    question: '「セブン確認済み」로 진행할 수 없습니다',
    answer: 'セブン化学発注書의 公式登録日과 真性行チェックリスト（確認済み）가 필요합니다. 그래도 안 되면 그 発注이 発注書에 연결되지 않은 것입니다. 연결은 작성할 때만 고를 수 있으므로, 発注書를 골라 다시 만들고 기존 発注은 取消レビュー로 끝냅니다.'
  },
  {
    question: '상태를 진행하려니 「証跡がないまま…」 경고가 나옵니다',
    answer: '그 단계의 증거（デザイン入稿データ・校正ゲラの版・納品記録）가 아직 없습니다. 文書・承認・納品確認 화면에서 먼저 기록하세요. ダッシュボード의 「막힌 건」에도 표시됩니다.'
  },
  {
    question: '代表承認을 기록할 수 없습니다',
    answer: '決済条件（G6）이 未確定이거나 조건을 충족하지 않았을 수 있습니다. メーカー発注 화면의 결제 게이트 줄에 이유가 나옵니다. 担当者에게는 승인 폼이 아니라 「代表者が行います」 안내가 보입니다.'
  },
  {
    question: 'EML을 올렸는데 「確認済み」가 되지 않습니다',
    answer: '보낸 메일 원본이 아니거나（전달・재저장된 파일）, 제목의 発注 코드・첨부 파일・宛先가 発注書와 다를 수 있습니다. 화면에 나온 거부 이유를 고친 뒤 다시 기록하고, 「送信未確認」이면 代表者가 原本을 보고 手動確認합니다.'
  },
  {
    question: '保留을 풀 수 없습니다',
    answer: '保留 해제와 取消レビュー 처리는 代表者만 합니다（理由 입력 필수）. 担当者는 ダッシュボード의 「代表者 대기」에서 대기 중인지 확인하고 代表者에게 요청합니다.'
  },
  {
    question: '「選択中の案件を開けません」이 나옵니다',
    answer: '기억된 案件이 삭제되었거나 담당에서 빠졌습니다. 화면 위 「案件」에서 다시 고르세요. 목록에 없으면 代表者에게 배정을 요청합니다.'
  },
  {
    question: '값이 「（閲覧権限なし）」로 나옵니다',
    answer: '역할 때문에 숨긴 값입니다. 金額・単価・手数料는 代表者만 볼 수 있고, 決済条件은 모든 역할에 보입니다.'
  }
];
