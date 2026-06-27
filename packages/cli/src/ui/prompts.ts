export type PromptOption<Value extends string> = {
  value: Value;
  label: string;
  hint?: string;
};

export type PromptAdapter = {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string): void;
  select<Value extends string>(input: {
    message: string;
    options: Array<PromptOption<Value>>;
    initialValue?: Value;
  }): Promise<Value>;
  text(input: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?(value: string): string | undefined;
  }): Promise<string>;
  password(input: {
    message: string;
    validate?(value: string): string | undefined;
  }): Promise<string>;
  confirm(input: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean>;
};
