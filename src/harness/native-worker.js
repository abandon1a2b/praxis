import { executeNative } from "./native-session.js";
process.once("disconnect", () => process.exit(0));
let session;
process.once("SIGTERM", async () => {
  try {
    await session?.abort();
    session?.dispose();
  } finally {
    process.exit(0);
  }
});
process.on("message", async (message) => {
  if (!message.command) return;
  try {
    if (!session) throw new Error("Session not ready");
    await (message.command === "steer"
      ? session.steer(message.text)
      : session.followUp(message.text));
    process.send({ ack: message.requestId });
  } catch (error) {
    process.send({ ack: message.requestId, error: error.message });
  }
});
process.once("message", async (input) => {
  try {
    process.send({
      result: await executeNative(
        input,
        (event) => process.send({ event }),
        (value) => {
          session = value;
        },
      ),
    });
  } catch (error) {
    process.send({ error: error.message });
  }
});
