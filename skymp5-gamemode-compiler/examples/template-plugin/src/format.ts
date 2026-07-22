export function formatFormId(formId: number): string {
  return `0x${formId.toString(16).padStart(8, "0")}`;
}
