import { type BSONSerializeOptions, type Document, resolveBSONOptions } from '../bson';
import { ReadPreference, type ReadPreferenceLike } from '../read_preference';
import type { Server } from '../sdam/server';
import type { ClientSession } from '../sessions';
import type { MongoDBNamespace } from '../utils';

export const Aspect = {
  READ_OPERATION: Symbol('READ_OPERATION'),
  WRITE_OPERATION: Symbol('WRITE_OPERATION'),
  RETRYABLE: Symbol('RETRYABLE'),
  EXPLAINABLE: Symbol('EXPLAINABLE'),
  SKIP_COLLATION: Symbol('SKIP_COLLATION'),
  CURSOR_CREATING: Symbol('CURSOR_CREATING'),
  MUST_SELECT_SAME_SERVER: Symbol('MUST_SELECT_SAME_SERVER')
} as const;

/** @public */
export type Hint = string | Document;

// eslint-disable-next-line @typescript-eslint/ban-types
export interface OperationConstructor extends Function {
  aspects?: Set<symbol>;
}

/** @public */
export interface OperationOptions extends BSONSerializeOptions {
  /** Specify ClientSession for this command */
  session?: ClientSession;
  willRetryWrite?: boolean;

  /** The preferred read preference (ReadPreference.primary, ReadPreference.primary_preferred, ReadPreference.secondary, ReadPreference.secondary_preferred, ReadPreference.nearest). */
  readPreference?: ReadPreferenceLike;

  /** @internal Hints to `executeOperation` that this operation should not unpin on an ended transaction */
  bypassPinningCheck?: boolean;
  omitReadPreference?: boolean;

  /** @internal TODO(NODE-5688): make this public */
  timeoutMS?: number;
}

/** @internal */
const kSession = Symbol('session');

/**
 * This class acts as a parent class for any operation and is responsible for setting this.options,
 * as well as setting and getting a session.
 * Additionally, this class implements `hasAspect`, which determines whether an operation has
 * a specific aspect.
 * @internal
 */
export abstract class AbstractOperation<TResult = any> {
  ns!: MongoDBNamespace;
  readPreference: ReadPreference;
  server!: Server;
  bypassPinningCheck: boolean;
  trySecondaryWrite: boolean;

  // BSON serialization options
  bsonOptions?: BSONSerializeOptions;

  options: OperationOptions;

  [kSession]: ClientSession | undefined;

  constructor(options: OperationOptions = {}) {
    this.readPreference = this.hasAspect(Aspect.WRITE_OPERATION)
      ? ReadPreference.primary
      : ReadPreference.fromOptions(options) ?? ReadPreference.primary;

    // Pull the BSON serialize options from the already-resolved options
    this.bsonOptions = resolveBSONOptions(options);

    this[kSession] = options.session != null ? options.session : undefined;

    this.options = options;
    this.bypassPinningCheck = !!options.bypassPinningCheck;
    this.trySecondaryWrite = false;
  }

  /** Must match the first key of the command object sent to the server.
  Command name should be stateless (should not use 'this' keyword) */
  abstract get commandName(): string;

  abstract execute(server: Server, session: ClientSession | undefined): Promise<TResult>;

  hasAspect(aspect: symbol): boolean {
    const ctor = this.constructor as OperationConstructor;
    if (ctor.aspects == null) {
      return false;
    }

    return ctor.aspects.has(aspect);
  }

  get session(): ClientSession | undefined {
    return this[kSession];
  }

  clearSession() {
    this[kSession] = undefined;
  }

  get canRetryRead(): boolean {
    return this.hasAspect(Aspect.RETRYABLE) && this.hasAspect(Aspect.READ_OPERATION);
  }

  get canRetryWrite(): boolean {
    return this.hasAspect(Aspect.RETRYABLE) && this.hasAspect(Aspect.WRITE_OPERATION);
  }
}

export function defineAspects(
  operation: OperationConstructor,
  aspects: symbol | symbol[] | Set<symbol>
): Set<symbol> {
  if (!Array.isArray(aspects) && !(aspects instanceof Set)) {
    aspects = [aspects];
  }

  aspects = new Set(aspects);
  Object.defineProperty(operation, 'aspects', {
    value: aspects,
    writable: false
  });

  return aspects;
}
