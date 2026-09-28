import { messageFixture } from "/Users/ino/Develop/openomni-w52/apps/openomni/test/helpers/message-fixture";
const fixture = messageFixture();
const result = await fixture.send({
  to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
  type: "message",
  content: "work",
  deadline: 200,
});
console.error("isError:", result.isError);
console.error("output:", JSON.stringify(result.output).slice(0, 600));
process.exit(0);
