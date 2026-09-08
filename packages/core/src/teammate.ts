export type TeammateWorkState =
  | "setup_required"
  | "runner_offline"
  | "ready"
  | "queued"
  | "working"
  | "needs_attention";

export type TeammateView = {
  teammateId: string;
  displayName: string;
  workState: TeammateWorkState;
  reason: string;
  home: {
    kind: "slack_channel";
    teamId: string;
    channelId: string;
    botUserId: string;
  };
  execution: {
    runnerId: string | null;
    projectTarget: {
      projectTargetId: string;
      provider: "github";
      owner: string;
      repo: string;
      executorId: string;
    } | null;
  };
  activeWork: {
    runId: string;
    state: string;
    outcomeState: string | null;
    updatedAt: string;
  } | null;
};
