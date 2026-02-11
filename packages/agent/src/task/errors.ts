/**
 * PolicyError — policy violation errors for task execution hardening
 *
 * Used to identify and handle policy violations in task execution:
 * - D6_task_from_task: trigger_task blocked in task context
 * - D6_task_creation: TaskManager.create blocked in task context
 * - anti_loop_self_retrigger: Completion event self-retrigger blocked
 */

export class PolicyError extends Error {
  public readonly name = "PolicyError" as const;

  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}
