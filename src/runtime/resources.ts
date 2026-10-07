interface Cleanup {
  readonly dispose: () => Promise<void>;
}

// Acquired registrations must be unwound even when setup fails before returning plugin cleanup.
const resourceScope = () => {
  const owned: Cleanup[] = [];
  let disposed = false;
  return {
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await Promise.allSettled(owned.toReversed().map(async (resource) => resource.dispose()));
    },
    own: <Value extends Cleanup>(value: Value): Value => {
      owned.push(value);
      return value;
    },
  };
};

export { resourceScope };
