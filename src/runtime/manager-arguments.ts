const managerArguments = (text: string): string[] => {
  const argv: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        argv.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (quote !== undefined || escaped) {
    throw new Error("Unmatched quote or trailing escape in manager arguments");
  }
  if (started) {
    argv.push(word);
  }
  return argv;
};

export { managerArguments };
