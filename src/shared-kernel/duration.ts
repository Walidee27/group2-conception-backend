import { InvalidInput } from './errors.ts'
import { Result } from './result.ts'

export class InvalidDuration extends InvalidInput {}

/** An immutable, non-negative, whole-millisecond duration. */
export class Duration {
  static readonly zero = new Duration(0)

  private constructor(readonly milliseconds: number) {
    Object.freeze(this)
  }

  static create(milliseconds: number): Result<Duration, InvalidDuration> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      return Result.fail(
        new InvalidDuration(
          'Duration must be a non-negative safe integer in milliseconds',
        ),
      )
    }
    return Result.succeed(new Duration(milliseconds))
  }

  /** Configuration and calculated invariants only, not unvalidated request input. */
  static makeUnsafe(milliseconds: number): Duration {
    return Result.getOrThrow(Duration.create(milliseconds))
  }

  toSeconds(): number {
    return this.milliseconds / 1000
  }

  toWholeSeconds(): number {
    return Math.ceil(this.toSeconds())
  }

  add(other: Duration): Result<Duration, InvalidDuration> {
    return Duration.create(this.milliseconds + other.milliseconds)
  }

  subtract(other: Duration): Result<Duration, InvalidDuration> {
    return Duration.create(this.milliseconds - other.milliseconds)
  }

  isLowerThan(other: Duration): boolean {
    return this.milliseconds < other.milliseconds
  }

  isHigherThan(other: Duration): boolean {
    return this.milliseconds > other.milliseconds
  }

  equals(other: Duration): boolean {
    return this.milliseconds === other.milliseconds
  }

  isZero(): boolean {
    return this.milliseconds === 0
  }
}
