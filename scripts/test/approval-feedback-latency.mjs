#!/usr/bin/env node
// Read combined ControlPlane/Jobs JSONL logs from stdin. No network or writes.
// Reports Slack's accepted update, NOT the time a user's device rendered it.
import {readFileSync} from "node:fs";
if(process.argv.includes("--help")){
  console.log("Usage: node scripts/test/approval-feedback-latency.mjs < feedback.jsonl\nAccepts structured timing logs or Railway JSONL with a JSON message field. Twenty accepted samples are required for the p95 target verdict.");
  process.exit(0);
}
const records=[];let invalidRecords=0;
for(const line of readFileSync(0,"utf8").split("\n").filter(Boolean)){
  try{
    let row=JSON.parse(line);
    if(typeof row.message==="string")row=JSON.parse(row.message);
    if(row.event!=="control_plane_feedback_timing")continue;
    if(!Number.isFinite(Date.parse(row.at))||typeof row.runId!=="string"||typeof row.operationId!=="string"){
      invalidRecords++;continue;
    }
    records.push(row);
  }catch{invalidRecords++;}
}
records.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
const elapsed=(a,b)=>{const value=Date.parse(b.at)-Date.parse(a.at);return value>=0?value:null;};
const approvals=new Map();
for(const row of records)if(row.stage==="approval_committed"&&typeof row.approvalRef==="string"){
  const key=JSON.stringify([row.runId,row.approvalRef]);
  if(!approvals.has(key))approvals.set(key,row);
}
const samples=[];let pending=0;
for(const approval of approvals.values()){
  const projections=records.filter(row=>row.stage==="projection_enqueued"&&row.runId===approval.runId
    &&row.approvalRef===approval.approvalRef&&Date.parse(row.at)>=Date.parse(approval.at));
  const completed=projections.map(projection=>({projection,settled:records.find(row=>
    row.stage==="delivery_settled"&&row.result==="accepted"&&row.runId===approval.runId
      &&row.operationId===projection.operationId&&Date.parse(row.at)>=Date.parse(projection.at))}))
    .filter(value=>value.settled).sort((a,b)=>Date.parse(a.settled.at)-Date.parse(b.settled.at))[0];
  if(!completed){pending++;continue;}
  const {projection,settled}=completed;
  const started=records.find(row=>row.stage==="delivery_started"&&row.runId===approval.runId
    &&row.operationId===projection.operationId);
  samples.push({runId:approval.runId,approvalRef:approval.approvalRef,
    approvalProcessingMs:approval.durationMs??null,approvalToEnqueuedMs:elapsed(approval,projection),
    deliveryQueueMs:started?.queueMs??null,slackRequestMs:settled.durationMs??null,
    approvalToAcceptedMs:elapsed(approval,settled)});
}
const durations=samples.map(x=>x.approvalToAcceptedMs).filter(x=>x!==null).sort((a,b)=>a-b);
const p95Ms=durations.length>=20?durations[Math.ceil(durations.length*0.95)-1]:null;
console.log(JSON.stringify({metric:"approval_commit_to_slack_update_accepted",targetMs:2000,
  sampleCount:durations.length,pending,invalidRecords,p95Ms,
  verdict:pending>0?"incomplete_samples":p95Ms===null?"insufficient_samples":p95Ms<=2000?"within_target":"above_target",samples},null,2));
