import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {expect,it} from "vitest";
const script=fileURLToPath(new URL("../../../scripts/test/approval-feedback-latency.mjs",import.meta.url));
function sample(index:number){
 const event={event:"control_plane_feedback_timing",runId:`run_${index}`};
 const at=(ms:number)=>new Date(Date.UTC(2026,8,8)+ms).toISOString();
 return [{...event,stage:"approval_committed",operationId:`action_${index}`,approvalRef:`effect_${index}`,at:at(0),durationMs:100},
   {...event,stage:"projection_enqueued",operationId:`intent_${index}`,approvalRef:`effect_${index}`,at:at(200),durationMs:30},
   {...event,stage:"delivery_started",operationId:`intent_${index}`,at:at(300),queueMs:100},
   {...event,stage:"delivery_settled",operationId:`intent_${index}`,at:at(500),durationMs:200,result:"accepted"}];
}
function report(rows:unknown[]){return JSON.parse(execFileSync(process.execPath,[script],{
 input:rows.map(x=>JSON.stringify(x)).join("\n"),encoding:"utf8"}));}
it("correlates exact approved projection without counting replay as another sample",()=>{
 const rows=sample(1);const result=report([...rows,rows[0]]);
 expect(result).toMatchObject({sampleCount:1,p95Ms:null,verdict:"insufficient_samples",pending:0});
 expect(result.samples[0]).toMatchObject({approvalProcessingMs:100,deliveryQueueMs:100,slackRequestMs:200,approvalToAcceptedMs:500});
 expect(report(rows.slice(0,3))).toMatchObject({sampleCount:0,pending:1});
});
it("requires twenty accepted samples and understands Railway log envelopes",()=>{
 const rows=Array.from({length:20},(_,i)=>sample(i)).flat().map(x=>({message:JSON.stringify(x)}));
 expect(report(rows)).toMatchObject({sampleCount:20,p95Ms:500,verdict:"within_target"});
 const native=sample(1).map(x=>({...x,message:"",level:"info",timestamp:x.at}));
 expect(report(native)).toMatchObject({sampleCount:1,pending:0,invalidRecords:0});
});
