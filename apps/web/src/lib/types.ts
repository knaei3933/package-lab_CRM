/** Result a server action reports back to the form that invoked it. */
export interface ActionState {
  ok: boolean;
  message: string;
}

export interface Choice {
  value: string;
  label: string;
}
