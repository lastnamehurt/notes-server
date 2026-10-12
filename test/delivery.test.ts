import { test } from "node:test";
import assert from "node:assert/strict";
import { sendOnce } from "../src/delivery.ts";

test("acknowledged delivery is not sent again after downstream bookkeeping failure", async () => {
  let sends = 0;
  let acknowledged = false;
  let bookkeepingAttempts = 0;
  const deliver = async () => {
    const sent = await sendOnce(acknowledged, async () => { sends++; }, async () => { acknowledged = true; });
    bookkeepingAttempts++;
    if (bookkeepingAttempts === 1) throw new Error("storage failed after acknowledgement");
    return sent;
  };
  await assert.rejects(deliver(), /storage failed/);
  assert.equal(await deliver(), false);
  assert.equal(sends, 1);
});

test("provider failure is retryable and not acknowledged", async () => {
  let acknowledged = false;
  let sends = 0;
  await assert.rejects(sendOnce(false, async () => { sends++; throw new Error("provider 503"); }, async () => { acknowledged = true; }), /503/);
  assert.equal(acknowledged, false);
  await sendOnce(acknowledged, async () => { sends++; }, async () => { acknowledged = true; });
  assert.equal(sends, 2);
  assert.equal(acknowledged, true);
});

test("each recurring occurrence has an independent acknowledgement", async () => {
  const receipts = new Set<number>();
  let sends = 0;
  for (const at of [1000, 2000, 1000, 2000]) {
    await sendOnce(receipts.has(at), async () => { sends++; }, async () => { receipts.add(at); });
  }
  assert.equal(sends, 2);
  assert.deepEqual([...receipts], [1000, 2000]);
});

test("acknowledgement storage failure is surfaced for retry", async () => {
  await assert.rejects(sendOnce(false, async () => {}, async () => { throw new Error("storage unavailable"); }), /storage unavailable/);
});
