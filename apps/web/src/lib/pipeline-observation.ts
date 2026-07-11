export function pipelineObservationKey(runAll: { jobId: string; status: string }): string {
  return `${runAll.jobId}:${runAll.status}`;
}
