const positiveMs = (value: unknown, scale = 1): number | undefined => {
  if (typeof value !== "number") {
    return undefined;
  }
  const ms = value * scale;
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647 ? ms : undefined;
};

export { positiveMs };
