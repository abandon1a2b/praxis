import { executeNative } from "./native-session.js";
process.once("disconnect", () => process.exit(0));
process.once("message", async (input) => {
  try {
    process.send({
      result: await executeNative(input, (event) => process.send({ event })),
    });
  } catch (error) {
    process.send({ error: error.message });
  }
});
