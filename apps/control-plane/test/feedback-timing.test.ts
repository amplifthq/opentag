import {describe,expect,it,vi} from "vitest";
import {feedbackElapsedMs,logFeedbackTiming} from "../src/modules/provider-delivery/feedback-timing.js";
describe("content-free approval feedback timing",()=>{
  it("keeps clock anomalies unknown instead of reporting zero latency",()=>{
    expect(feedbackElapsedMs(100,113.4)).toBe(13);
    expect(feedbackElapsedMs(100,87)).toBeNull();
    expect(feedbackElapsedMs(NaN,100)).toBeNull();
  });
  it("does not accept source text, URLs, tokens or arbitrary additional fields",()=>{
    const logger={info:vi.fn(),warn:vi.fn()};
    const event={stage:"approval_committed" as const,runId:"run_test",operationId:"action_test",
      approvalRef:"effect_test",at:"2026-09-08T00:00:00.000Z",durationMs:12,result:"authorized" as const};
    expect(logFeedbackTiming(event,logger)).toBe(true);
    expect(logFeedbackTiming({...event,operationId:"https://secret.example/token"},logger)).toBe(false);
    expect(logFeedbackTiming({...event,token:"not-a-real-secret"} as typeof event,logger)).toBe(false);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logFeedbackTiming(event,{info(){throw Error("sink down");},warn(){}})).toBe(false);
  });
});
