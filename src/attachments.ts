import type { CommandInvocation } from "@opencode/plugin/promise/command";

type Prompt = CommandInvocation["prompt"];
type Mention = NonNullable<NonNullable<Prompt["files"]>[number]["mention"]>;

// The prompt schema allows explicit `undefined` fields but the client input doesn't, so rebuild
// each attachment with only the fields that are set.
const mention = (value: Mention | undefined) =>
  value === undefined ? {} : { mention: { end: value.end, start: value.start, text: value.text } };

const forwardAttachments = (prompt: Prompt) => {
  const files = prompt.files?.map((file) => ({
    uri: file.uri,
    ...(file.name === undefined ? {} : { name: file.name }),
    ...(file.description === undefined ? {} : { description: file.description }),
    ...mention(file.mention),
  }));
  const agents = prompt.agents?.map((agent) => ({ name: agent.name, ...mention(agent.mention) }));
  const skills = prompt.skills?.map((skill) => ({ id: skill.id, ...mention(skill.mention) }));
  return {
    ...(files === undefined ? {} : { files }),
    ...(agents === undefined ? {} : { agents }),
    ...(skills === undefined ? {} : { skills }),
  };
};

export { forwardAttachments };
