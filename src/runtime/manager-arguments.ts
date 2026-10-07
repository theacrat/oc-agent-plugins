const escapesNext = (text: string, index: number): boolean =>
  index === text.length - 1 || /[\\"'\s]/u.test(text.charAt(index + 1));

const managerArguments = (text: string): string[] => {
  const argv: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'" && escapesNext(text, index)) {
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
    } else if (/\s/u.test(character ?? "")) {
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
