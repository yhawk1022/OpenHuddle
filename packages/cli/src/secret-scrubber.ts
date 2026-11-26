import { scrubWorkText } from "@openhuddle/core-governance";

export { scrubWorkText as scrubSensitiveText };

export function containsSensitiveSecret(raw: string): boolean {
  return scrubWorkText(raw) !== raw;
}
