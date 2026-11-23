import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * UI batch C review fixes H1 / L3 / L8 — the form shell's submit path and the
 * dialog buttons, run as behaviour without a DOM library: React's hooks are
 * replaced by plain stand-ins (one render; state setters do nothing), the
 * component is called as a function and the handlers it puts on <form> and
 * on the dialog are invoked with small fake DOM objects.
 *
 * What is pinned: every submit is default-prevented (React then neither runs
 * nor resets after the action), the shell dispatches the action itself with
 * the pressed button's name/value in tree order, a confirmed dialog
 * dispatches exactly once and the next submit asks again, a pending or
 * invalid submit dispatches nothing, the form is reset only after a success,
 * and キャンセル / the confirm button call the right handler.
 */
const effects = vi.hoisted(() => ({ list: [] as Array<() => unknown> }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
    useEffect: (effect: () => unknown) => {
      effects.list.push(effect);
    },
    useRef: (value: unknown) => ({ current: value === undefined ? null : value }),
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useId: () => ':r0:',
    useContext: () => null,
    startTransition: (scope: () => void) => scope()
  };
});

// P0 R05: the shell holds a ref-held in-flight lock per form; the test keeps the instance of the last render to release it as a result would.
const lock = vi.hoisted(() => ({ list: [] as Array<{ observe: (result: unknown, pending: boolean) => void; busy: boolean }> }));
vi.mock('../apps/web/src/lib/saved-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../apps/web/src/lib/saved-record.js')>();
  return {
    ...actual,
    createSubmitInFlight: () => {
      const created = actual.createSubmitInFlight();
      lock.list.push(created);
      return created;
    }
  };
});

const { FeedbackForm, formDataFor } = await import('../apps/web/src/components/form-feedback.js');
const { ConfirmDialog } = await import('../apps/web/src/components/ConfirmDialog.js');

// Minimal DOM stand-ins: only what the shell reads.
class FakeElement {
  dataset: Record<string, string> = {};
  parentNode: FakeContainer | null = null;
  name = '';
  value = '';
  attributes: Record<string, string> = {};
  ownerDocument = { createElement: () => new FakeElement() };
  focus = vi.fn();
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  getAttribute() {
    return null;
  }
  closest() {
    return null;
  }
}
class FakeButton extends FakeElement {}
class FakeInput extends FakeElement {
  type = 'text';
  disabled = false;
  willValidate = true;
  validity: Record<string, boolean> = { valid: true };
  validationMessage = '';
  minLength = 0;
  maxLength = 0;
  min = '';
  max = '';
}

/** The form's child list; insertBefore/removeChild keep tree order like the DOM. */
class FakeContainer {
  constructor(readonly nodes: FakeElement[]) {
    for (const node of nodes) node.parentNode = this;
  }
  insertBefore(node: FakeElement, before: FakeElement) {
    this.nodes.splice(this.nodes.indexOf(before), 0, node);
    node.parentNode = this;
  }
  removeChild(node: FakeElement) {
    this.nodes.splice(this.nodes.indexOf(node), 1);
    node.parentNode = null;
  }
}

/**
 * new FormData(form): the named entries in tree order at that moment, buttons
 * excluded (a button only contributes as the constructor's submitter, which
 * React never passes) — what the browser does.
 */
class FakeFormData {
  readonly entries: Array<[string, string]>;
  readonly formAttribute: Array<string | undefined>;
  constructor(form: FakeForm) {
    const named = form.container.nodes.filter((node) => node.name.length > 0 && !(node instanceof FakeButton));
    this.entries = named.map((node) => [node.name, node.value]);
    this.formAttribute = named.map((node) => node.attributes.form);
  }
  /** Like FormData.get: the first entry of that name (p6: the shell reads the 手動確認 result from it). */
  get(name: string): string | null {
    return this.entries.find(([entry]) => entry === name)?.[1] ?? null;
  }
}

interface FakeForm {
  id: string;
  container: FakeContainer;
  elements: FakeElement[];
  querySelectorAll: () => FakeElement[];
  reset: ReturnType<typeof vi.fn>;
  addEventListener: () => void;
  removeEventListener: () => void;
}

function fakeForm(nodes: FakeElement[], id = ''): FakeForm {
  const container = new FakeContainer(nodes);
  return {
    id,
    container,
    get elements() {
      return container.nodes;
    },
    querySelectorAll: () => [],
    reset: vi.fn(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
}

function field(name: string, value: string): FakeElement {
  return Object.assign(new FakeElement(), { name, value });
}
function button(name: string, value: string): FakeButton {
  return Object.assign(new FakeButton(), { name, value });
}

function submitEvent(form: FakeForm, submitter: FakeElement | null) {
  return { preventDefault: vi.fn(), currentTarget: form, nativeEvent: { submitter }, target: form };
}

type FormProps = { onSubmit: (event: unknown) => void; ref: { current: unknown }; action: unknown; children: ReactNode[] };
type DialogProps = { onConfirm: () => void; onCancel: () => void };

/** One render of the shell: the <form> element and, when a confirm is set, the dialog element. */
function renderShell(props: Partial<Parameters<typeof FeedbackForm>[0]> = {}) {
  effects.list = [];
  lock.list = [];
  const action = vi.fn();
  const tree = FeedbackForm({ action, state: null, children: null, ...props } as Parameters<typeof FeedbackForm>[0]) as ReactElement<FormProps>;
  // P0 R03/R05: the shell now starts with the hidden project / idempotency inputs; the dialog is the child that carries the handlers.
  const dialog = ((tree.props.children as ReactNode[]).find(
    (child) => child !== null && typeof child === 'object' && 'props' in child && typeof (child as ReactElement<DialogProps>).props.onConfirm === 'function'
  ) ?? null) as ReactElement<DialogProps> | null;
  return { action: (props.action as ReturnType<typeof vi.fn> | undefined) ?? action, tree, dialog };
}

const sevenSpec = () => ({ options: { title: '承認を記録しますか？', body: '' }, summary: [], confirmLabel: '承認する' });

beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLButtonElement', FakeButton);
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLSelectElement', class {});
  vi.stubGlobal('HTMLTextAreaElement', class {});
  vi.stubGlobal('RadioNodeList', class {});
  vi.stubGlobal('FormData', FakeFormData);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// formDataFor: the same entries React builds (createFormDataWithSubmitter)
// ---------------------------------------------------------------------------

describe('formDataFor: the pressed button joins the entries at its own place in tree order', () => {
  it('a button between fields: its name/value sit between them, and the temporary input is gone afterwards', () => {
    const seven = button('organization', 'seven');
    const form = fakeForm([field('revisionId', 'r1'), button('organization', 'customer'), seven, field('after', 'x')]);
    const data = formDataFor(form as unknown as HTMLFormElement, seven as unknown as HTMLElement) as unknown as FakeFormData;
    expect(data.entries).toEqual([['revisionId', 'r1'], ['organization', 'seven'], ['after', 'x']]);
    expect(form.container.nodes).toHaveLength(4);
    expect(form.container.nodes.every((node) => node.parentNode === form.container)).toBe(true);
  });

  it('the temporary input carries form="<id>" when the form has an id, none otherwise', () => {
    const submit = button('go', '1');
    const withId = fakeForm([submit], 'f1');
    expect((formDataFor(withId as unknown as HTMLFormElement, submit as unknown as HTMLElement) as unknown as FakeFormData).formAttribute).toEqual(['f1']);
    const submit2 = button('go', '1');
    const withoutId = fakeForm([submit2]);
    expect((formDataFor(withoutId as unknown as HTMLFormElement, submit2 as unknown as HTMLElement) as unknown as FakeFormData).formAttribute).toEqual([undefined]);
  });

  it('no submitter (Enter with no button / a dialog held without one): just the form, nothing added', () => {
    const form = fakeForm([field('poId', 'p1')]);
    expect((formDataFor(form as unknown as HTMLFormElement, null) as unknown as FakeFormData).entries).toEqual([['poId', 'p1']]);
  });

  it('an unnamed button adds a nameless input, which FormData skips (as in React)', () => {
    const plain = button('', '');
    const form = fakeForm([field('poId', 'p1'), plain]);
    expect((formDataFor(form as unknown as HTMLFormElement, plain as unknown as HTMLElement) as unknown as FakeFormData).entries).toEqual([['poId', 'p1']]);
  });
});

// ---------------------------------------------------------------------------
// The submit path (H1, L3)
// ---------------------------------------------------------------------------

describe('H1: every submit is prevented and dispatched by the shell', () => {
  it('a valid submit without a dialog: prevented, then the action runs once with the button in the entries', () => {
    const { tree, action } = renderShell();
    const submit = button('organization', 'customer');
    const form = fakeForm([field('poId', 'p1'), submit]);
    const event = submitEvent(form, submit);
    tree.props.onSubmit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect((action.mock.calls[0]![0] as FakeFormData).entries).toEqual([['poId', 'p1'], ['organization', 'customer']]);
  });

  it('while pending: prevented and nothing is dispatched', () => {
    const { tree, action } = renderShell({ pending: true });
    const event = submitEvent(fakeForm([field('poId', 'p1')]), null);
    tree.props.onSubmit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it('review NM1: after IDEMPOTENCY_KEY_REUSED the submit is prevented and nothing is dispatched (the form is locked)', () => {
    const reused = { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', message: '前回の送信が処理済みの可能性があります。', settled: false };
    const { tree, action } = renderShell({ state: reused });
    const submit = button('organization', 'customer');
    const event = submitEvent(fakeForm([field('poId', 'p1'), submit]), submit);
    tree.props.onSubmit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    // A timeout (no REUSED) is not locked: the same intent may be retried with the kept key.
    const timeout = renderShell({ state: { ok: false, code: 'API_TIMEOUT', message: 'x', settled: false } });
    const retry = submitEvent(fakeForm([field('poId', 'p1')]), null);
    timeout.tree.props.onSubmit(retry);
    expect(timeout.action).toHaveBeenCalledTimes(1);
  });

  it('an invalid field: prevented, nothing dispatched, focus on the field', () => {
    const { tree, action } = renderShell();
    const missing = Object.assign(new FakeInput(), { name: 'code', validity: { valid: false, valueMissing: true } });
    const event = submitEvent(fakeForm([missing]), null);
    tree.props.onSubmit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    expect(missing.focus).toHaveBeenCalledTimes(1);
  });

  it('the <form> still carries the action for the pre-hydration POST', () => {
    const { tree, action } = renderShell();
    expect(tree.props.action).toBe(action);
  });
});

describe('H1 / L3: the confirm dialog dispatches the held submit exactly once', () => {
  it('submit → held (nothing sent) → confirm → sent once with the pressed button → confirm again sends nothing', () => {
    const { tree, action, dialog } = renderShell({ confirm: sevenSpec });
    const seven = button('organization', 'seven');
    const form = fakeForm([field('revisionId', 'r1'), seven]);
    tree.props.ref.current = form;
    const event = submitEvent(form, seven);
    tree.props.onSubmit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();

    dialog!.props.onConfirm();
    expect(action).toHaveBeenCalledTimes(1);
    expect((action.mock.calls[0]![0] as FakeFormData).entries).toContainEqual(['organization', 'seven']);

    dialog!.props.onConfirm(); // double click
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('after a confirmed dispatch the next submit asks again (no armed gate — review L3)', () => {
    const { tree, action, dialog } = renderShell({ confirm: sevenSpec });
    const form = fakeForm([field('poId', 'p1')]);
    tree.props.ref.current = form;
    tree.props.onSubmit(submitEvent(form, null));
    dialog!.props.onConfirm();
    expect(action).toHaveBeenCalledTimes(1);
    // P0 R05: while the first action is still running (no result yet) a second submit is dropped.
    const dropped = submitEvent(form, null);
    tree.props.onSubmit(dropped);
    dialog!.props.onConfirm();
    expect(action).toHaveBeenCalledTimes(1);
    // The result arrives (a new state object): the lock is released and the next submit asks again.
    lock.list.at(-1)!.observe({ ok: true, message: '記録しました。' }, false);
    tree.props.onSubmit(submitEvent(form, null));
    expect(action).toHaveBeenCalledTimes(1); // held again, not sent
    dialog!.props.onConfirm();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('キャンセル drops the held submit: a later confirm sends nothing', () => {
    const { tree, action, dialog } = renderShell({ confirm: sevenSpec });
    const form = fakeForm([field('poId', 'p1')]);
    tree.props.ref.current = form;
    tree.props.onSubmit(submitEvent(form, null));
    dialog!.props.onCancel();
    dialog!.props.onConfirm();
    expect(action).not.toHaveBeenCalled();
  });
});

describe('H1: the reset after a result (effects run by hand)', () => {
  const dispatchEvent = vi.fn();
  beforeEach(() => {
    dispatchEvent.mockClear();
    vi.stubGlobal('window', { dispatchEvent });
  });

  function runWith(state: { ok: boolean; message: string } | null) {
    const { tree } = renderShell({ state });
    const form = fakeForm([field('poId', 'p1')]);
    tree.props.ref.current = form;
    for (const effect of effects.list) effect();
    return form.reset;
  }

  it('success → form.reset() once', () => {
    expect(runWith({ ok: true, message: '記録しました。' })).toHaveBeenCalledTimes(1);
  });

  it('success → the screen is told once (P0 R06 saved-record event)', () => {
    runWith({ ok: true, message: '記録しました。' });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('refusal → the screen is not told', () => {
    runWith({ ok: false, message: '本登録日が必要です' });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('refusal → no reset (every entered value stays)', () => {
    expect(runWith({ ok: false, message: '本登録日が必要です' })).not.toHaveBeenCalled();
  });

  it('no result yet → no reset', () => {
    expect(runWith(null)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L8: the dialog buttons call the right handler
// ---------------------------------------------------------------------------

/** Every <button> element of a tree, depth first. */
function buttons(node: ReactNode): Array<ReactElement<{ onClick: () => void; children: ReactNode }>> {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  const element = node as ReactElement<{ children?: ReactNode }>;
  const own = element.type === 'button' ? [element as ReactElement<{ onClick: () => void; children: ReactNode }>] : [];
  return [...own, ...buttons(element.props?.children ?? null)];
}

describe('L8: ConfirmDialog wiring', () => {
  function dialogButtons() {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const tree = ConfirmDialog({ open: true, title: 't', body: 'b', summary: [], confirmLabel: '記録する', onConfirm, onCancel });
    return { list: buttons(tree), onConfirm, onCancel };
  }

  it('キャンセル calls onCancel only', () => {
    const { list, onConfirm, onCancel } = dialogButtons();
    const cancel = list.find((element) => element.props.children === 'キャンセル')!;
    cancel.props.onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the confirm button calls onConfirm only', () => {
    const { list, onConfirm, onCancel } = dialogButtons();
    const confirm = list.find((element) => element.props.children === '記録する')!;
    confirm.props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('exactly two buttons, キャンセル first', () => {
    expect(dialogButtons().list.map((element) => element.props.children)).toEqual(['キャンセル', '記録する']);
  });
});
