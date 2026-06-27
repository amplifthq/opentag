export type CliLanguage = "en" | "zh-CN";

export const LANGUAGE_OPTIONS: Array<{
  id: CliLanguage;
  label: string;
  hint: string;
}> = [
  { id: "en", label: "English", hint: "Default" },
  { id: "zh-CN", label: "简体中文", hint: "Chinese" }
];

export function parseCliLanguage(value: string): CliLanguage {
  if (value === "en" || value === "zh-CN") {
    return value;
  }
  throw new Error("Language must be en or zh-CN.");
}
