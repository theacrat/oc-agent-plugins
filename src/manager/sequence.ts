const forEachSequential = async <Value>(
  values: readonly Value[],
  visit: (value: Value) => Promise<void>,
): Promise<void> => {
  for (const value of values) {
    // Sequential filesystem and Git operations keep resource usage bounded.
    // eslint-disable-next-line eslint/no-await-in-loop
    await visit(value);
  }
};

export { forEachSequential };
