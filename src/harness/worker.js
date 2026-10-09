import { piReview } from "../pi-review.js";

process.once("disconnect", () => process.exit(0));

process.on("message", async ({ batch, config, context }) => {
  try {
    process.send({ result: await piReview(batch, config, context) });
  } catch (error) {
    process.send({ error: error.message });
  }
});
