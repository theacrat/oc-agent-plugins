type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === "string");

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { error: errorMessage(error), ok: false };
  }
};

export type { JsonRecord };
export { errorMessage, isRecord, isStringArray, isStringRecord, parseJson };
