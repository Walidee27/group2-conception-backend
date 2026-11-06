import {
  Conflict,
  InvalidInput,
  NotFound,
  Unauthorized,
} from '#/features/events/domain/errors.ts'
import type { ApplicationError } from '#/features/events/application/ports.ts'
import { Result } from '#/shared-kernel/result.ts'
import type { Telemetry } from '#/shared-kernel/telemetry.ts'

function outcomeOf(error: ApplicationError): string {
  if (error instanceof Conflict) {
    return 'conflict'
  }
  if (error instanceof NotFound) {
    return 'not_found'
  }
  if (error instanceof InvalidInput) {
    return 'invalid_input'
  }
  if (error instanceof Unauthorized) {
    return 'unauthorized'
  }
  return 'failure'
}

export function observedCommand<Value>(
  telemetry: Telemetry,
  command: string,
  work: () => Promise<Result<Value, ApplicationError>>,
): Promise<Result<Value, ApplicationError>> {
  return telemetry.operations.run(command, async () => {
    try {
      const result = await work()
      if (Result.isFailure(result)) {
        const outcome = outcomeOf(result.error)
        telemetry.metrics.increment('events.commands', { command, outcome })
        telemetry.logger.info('Commande refusée', { command, outcome })
        return result
      }
      telemetry.metrics.increment('events.commands', {
        command,
        outcome: 'success',
      })
      return result
    } catch (error) {
      telemetry.metrics.increment('events.commands', {
        command,
        outcome: 'unexpected_error',
      })
      throw error
    }
  })
}
